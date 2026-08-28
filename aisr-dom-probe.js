/*
 * AISR READ-ONLY DOM PROBE
 *
 * Use only on the authenticated AISR form page after reviewing this source:
 * 1. Open browser developer tools on the AISR form page.
 * 2. Paste this entire file into the Console and run it.
 * 3. Save the returned object or the "AISR READ-ONLY DOM PROBE RESULT" log.
 *
 * The probe records labels, element identifiers/names/types, select-option
 * metadata, and form membership. It deliberately does not read user-entered
 * values, cookies, credentials, tokens, storage, network traffic, or sessions.
 */

(() => {
  "use strict";

  const compactText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const forms = [...document.querySelectorAll("form")];

  const labelTextFor = (control) => {
    const labels = [];
    if (control.id) {
      for (const label of document.querySelectorAll("label[for]")) {
        if (label.htmlFor === control.id) labels.push(compactText(label.textContent));
      }
    }
    const wrappingLabel = control.closest("label");
    if (wrappingLabel) labels.push(compactText(wrappingLabel.textContent));
    return [...new Set(labels.filter(Boolean))];
  };

  const controls = [...document.querySelectorAll("input, select, textarea, button")].map((control) => {
    const tagName = control.tagName.toLowerCase();
    const type = tagName === "input" || tagName === "button"
      ? compactText(control.getAttribute("type") || (tagName === "button" ? "submit" : "text")).toLowerCase()
      : tagName;
    const formIndex = control.form ? forms.indexOf(control.form) : -1;
    const record = {
      tagName,
      type,
      id: compactText(control.id),
      name: compactText(control.getAttribute("name")),
      role: compactText(control.getAttribute("role")),
      ariaLabel: compactText(control.getAttribute("aria-label")),
      labels: labelTextFor(control),
      required: control.hasAttribute("required"),
      disabled: control.hasAttribute("disabled"),
      readOnly: control.hasAttribute("readonly"),
      autocomplete: compactText(control.getAttribute("autocomplete")),
      formIndex,
    };

    if (tagName === "button") record.buttonText = compactText(control.textContent);
    if (tagName === "select") {
      record.options = [...control.querySelectorAll("option")].map((option) => ({
        value: option.getAttribute("value") ?? "",
        text: compactText(option.textContent),
      }));
    }
    return record;
  });

  const result = {
    schemaVersion: 1,
    purpose: "AISR_SELECTOR_MAPPING_READ_ONLY",
    forms: forms.map((form, index) => ({
      index,
      id: compactText(form.id),
      name: compactText(form.getAttribute("name")),
      method: compactText(form.getAttribute("method") || "get").toLowerCase(),
      controlIndexes: controls
        .map((control, controlIndex) => control.formIndex === index ? controlIndex : -1)
        .filter((controlIndex) => controlIndex >= 0),
    })),
    controls,
  };

  console.info("AISR READ-ONLY DOM PROBE RESULT", result);
  return result;
})();
