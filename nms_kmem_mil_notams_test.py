#!/usr/bin/env python3
"""
KMEM MIL NOTAM NMS test pull.

Reads credentials from:
  NMS_CLIENT_ID
  NMS_CLIENT_SECRET

Run:
  set NMS_CLIENT_ID=YOUR_KEY_HERE
  set NMS_CLIENT_SECRET=YOUR_SECRET_HERE
  py nms_kmem_mil_notams_test.py

Writes:
  nms_kmem_mil_notams_output.json

Does not modify weather.json or GitHub.
"""

import base64
import html
import json
import os
import re
import ssl
import time
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from xml.etree import ElementTree as ET

AUTH_URL = "https://api-staging.cgifederal-aim.com/v1/auth/token"
BASE_URL = "https://api-staging.cgifederal-aim.com/nmsapi/v1"
LOCATION = "KMEM"
OUTPUT_FILE = "nms_kmem_mil_notams_output.json"

# Temporary for testing if Windows/Python cert trust acts up.
ALLOW_INSECURE_SSL_FALLBACK = True

# NMS staging showed a rate limit around 1 request/sec.
REQUEST_DELAY_SECONDS = 1.25
MAX_RETRIES = 3


def utc_now_z():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def ssl_context(insecure=False):
    return ssl._create_unverified_context() if insecure else ssl.create_default_context()


def http_request(method, url, headers=None, body=None, timeout=45):
    req = Request(url=url, data=body, headers=headers or {}, method=method)

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urlopen(req, timeout=timeout, context=ssl_context(False)) as resp:
                return resp.read()

        except HTTPError as exc:
            error_text = exc.read().decode("utf-8", errors="replace")

            if exc.code == 429 and attempt < MAX_RETRIES:
                wait = REQUEST_DELAY_SECONDS * attempt + 1.0
                print(f"HTTP 429 rate limit. Waiting {wait:.1f} sec then retrying...")
                time.sleep(wait)
                continue

            raise RuntimeError(f"HTTP {exc.code}: {error_text}") from exc

        except (ssl.SSLError, URLError) as exc:
            if not ALLOW_INSECURE_SSL_FALLBACK:
                raise

            print(f"Normal SSL failed or was blocked: {exc}")
            print("Trying temporary insecure SSL fallback for NMS test...")

            try:
                with urlopen(req, timeout=timeout, context=ssl_context(True)) as resp:
                    return resp.read()
            except HTTPError as exc2:
                error_text = exc2.read().decode("utf-8", errors="replace")

                if exc2.code == 429 and attempt < MAX_RETRIES:
                    wait = REQUEST_DELAY_SECONDS * attempt + 1.0
                    print(f"HTTP 429 rate limit. Waiting {wait:.1f} sec then retrying...")
                    time.sleep(wait)
                    continue

                raise RuntimeError(f"HTTP {exc2.code}: {error_text}") from exc2

    raise RuntimeError("Request failed after retries.")


def get_token(client_id, client_secret):
    auth = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")

    raw = http_request(
        "POST",
        AUTH_URL,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body=b"grant_type=client_credentials",
    )

    data = json.loads(raw.decode("utf-8"))
    token = data.get("access_token")

    if not token:
        raise RuntimeError(f"Token response missing access_token: {data}")

    print(f"NMS token OK. status={data.get('status')}; expires_in={data.get('expires_in')} sec")
    return token


def nms_get_json(path, token, query=None, response_format=None):
    url = BASE_URL + path

    if query:
        url += "?" + urlencode(query)

    headers = {"Authorization": f"Bearer {token}"}

    if response_format:
        headers["nmsResponseFormat"] = response_format

    raw = http_request("GET", url, headers=headers)
    return json.loads(raw.decode("utf-8", errors="replace"))


def parse_xml(xml_text):
    return ET.fromstring(xml_text)


def elems(root, local_name):
    for elem in root.iter():
        if elem.tag.endswith("}" + local_name) or elem.tag == local_name:
            yield elem


def first_text(root, local_name):
    for elem in elems(root, local_name):
        if elem.text and elem.text.strip():
            return elem.text.strip()
    return None


def all_text(root, local_name):
    vals = []

    for elem in elems(root, local_name):
        if elem.text and elem.text.strip():
            vals.append(elem.text.strip())

    return vals


def extract_notam_number(root, fallback):
    series = first_text(root, "series")
    number = first_text(root, "number")
    year = first_text(root, "year")

    if series and number and year:
        if series.upper() == "M":
            return f"M{int(number):04d}/{str(year)[-2:]}"
        return f"{series}{number}/{str(year)[-2:]}"

    return fallback


def extract_event_text(root):
    txt = first_text(root, "text")

    if txt:
        return re.sub(r"\s+", " ", txt).strip()

    simple = first_text(root, "simpleText")

    if simple and simple.upper() != "NOT AVAILABLE":
        return re.sub(r"\s+", " ", simple).strip()

    formatted = first_text(root, "formattedText")

    if formatted:
        cleaned = html.unescape(formatted)
        cleaned = re.sub(r"<[^>]+>", " ", cleaned)
        return re.sub(r"\s+", " ", cleaned).strip()

    return "TEXT NOT FOUND"


def severity(text):
    t = text.upper()

    if "ARFF STATUS RED" in t:
        return "red"

    if ("RWY" in t and ("CLSD" in t or "CLOSED" in t)) or "ARFF" in t:
        return "red"

    if any(k in t for k in ["INOP", "U/S", "DSN", "COMM", "MIL RAMP", "ILS", "PAPI", "RVR"]):
        return "amber"

    return "green"


def display_text(text):
    t = re.sub(r"\s+", " ", text.strip())
    t = t.replace("MIL RAMP MIL RAMP", "MIL RAMP")
    t = t.replace("UNTIL FURTHER NOTICE", "UFN")

    return t if len(t) <= 150 else t[:147].rstrip() + "..."


def main():
    client_id = os.environ.get("NMS_CLIENT_ID")
    client_secret = os.environ.get("NMS_CLIENT_SECRET")

    if not client_id or not client_secret:
        raise SystemExit(
            "Missing credentials. Run:\n"
            "  set NMS_CLIENT_ID=YOUR_KEY_HERE\n"
            "  set NMS_CLIENT_SECRET=YOUR_SECRET_HERE"
        )

    token = get_token(client_id, client_secret)

    print(f"Pulling checklist for {LOCATION}...")
    time.sleep(REQUEST_DELAY_SECONDS)

    checklist_resp = nms_get_json("/notams/checklist", token, query={"location": LOCATION})
    checklist = checklist_resp.get("data", {}).get("checklist", [])

    mil = [
        x for x in checklist
        if str(x.get("classification", "")).upper() == "MILITARY"
    ]

    print(f"Checklist records returned: {len(checklist)}")
    print(f"MILITARY records found: {len(mil)}")

    notams = []

    for item in sorted(mil, key=lambda x: x.get("number", "")):
        time.sleep(REQUEST_DELAY_SECONDS)

        num = item.get("number")
        print(f"Pulling {num}...")

        detail = nms_get_json(
            "/notams",
            token,
            query={"location": LOCATION, "notamNumber": num},
            response_format="AIXM",
        )

        aixm_list = detail.get("data", {}).get("aixm", [])

        if not aixm_list:
            print(f"  No AIXM returned for {num}")
            continue

        root = parse_xml(aixm_list[0])
        txt = extract_event_text(root)
        classifications = all_text(root, "classification")
        last_updates = all_text(root, "lastUpdated")

        record = {
            "number": extract_notam_number(root, num),
            "classification": classifications[-1] if classifications else "MIL",
            "severity": severity(txt),
            "text": txt,
            "displayText": display_text(txt),
            "effectiveStart": first_text(root, "effectiveStart"),
            "effectiveEnd": first_text(root, "effectiveEnd"),
            "lastUpdated": last_updates[-1] if last_updates else item.get("lastUpdated"),
            "source": "FAA_NMS_STAGING",
        }

        notams.append(record)

    result = {
        "status": "Success",
        "generatedZ": utc_now_z(),
        "location": LOCATION,
        "source": "FAA_NMS_STAGING",
        "milNotamCount": len(notams),
        "milNotamStatus": f"{len(notams)} ACTIVE" if notams else "NONE ACTIVE",
        "milNotamScrollText": "  |  ".join(
            f"{n['number']} {n['displayText']}" for n in notams
        ),
        "milNotams": notams,
    }

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print()
    print("KMEM MIL NOTAM pull complete.")
    print(f"Status: {result['milNotamStatus']}")
    print(f"Wrote:  {OUTPUT_FILE}")
    print()

    for n in notams:
        print(f"{n['severity'].upper():5} {n['number']}: {n['displayText']}")


if __name__ == "__main__":
    main()