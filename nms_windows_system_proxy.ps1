[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$expectedHost = "api-staging.cgifederal-aim.com"
$statusMarker = "__KMEM_NMS_HTTP_STATUS_7E3C1B9A__:"
# The parent supplies only one of these values; endpoint validation below
# rejects mismatched stages/timeouts before any network request is created.
# Values mirror TOKEN_TOTAL_TIMEOUT_SECONDS / NOTAMS_TOTAL_TIMEOUT_SECONDS in
# nms_kmem_mil_notams_test.py (congested-link budget, 2026-09-11).
$tokenTimeoutSeconds = 35
$notamsTimeoutSeconds = 120
$timeoutSeconds = 0
$responseLimitBytes = 32MB

$client = $null
$handler = $null
$message = $null
$response = $null
$responseStream = $null
$responseBuffer = $null
$timeoutSource = $null

function Write-SafeMarker([string]$Name, [string]$Value) {
    [Console]::Error.WriteLine("NMS system proxy ${Name}: $Value")
}

function Stop-WithReason([string]$Reason, [int]$ExitCode) {
    Write-SafeMarker "reason" $Reason
    exit $ExitCode
}

function Get-SafeFailure([Exception]$Exception) {
    $current = $Exception
    while ($null -ne $current) {
        if ($current -is [System.Security.Authentication.AuthenticationException]) {
            return [pscustomobject]@{ Reason = "TLS_SECURITY"; ExitCode = 60 }
        }
        if ($current -is [System.Threading.Tasks.TaskCanceledException] -or
            $current -is [System.TimeoutException]) {
            return [pscustomobject]@{ Reason = "TIMEOUT"; ExitCode = 28 }
        }
        if ($current -is [System.Net.WebException]) {
            switch ($current.Status) {
                ([System.Net.WebExceptionStatus]::NameResolutionFailure) {
                    return [pscustomobject]@{ Reason = "DNS"; ExitCode = 6 }
                }
                ([System.Net.WebExceptionStatus]::ProxyNameResolutionFailure) {
                    return [pscustomobject]@{ Reason = "PROXY_ROUTE"; ExitCode = 7 }
                }
                ([System.Net.WebExceptionStatus]::Timeout) {
                    return [pscustomobject]@{ Reason = "TIMEOUT"; ExitCode = 28 }
                }
                ([System.Net.WebExceptionStatus]::TrustFailure) {
                    return [pscustomobject]@{ Reason = "TLS_SECURITY"; ExitCode = 60 }
                }
                ([System.Net.WebExceptionStatus]::SecureChannelFailure) {
                    return [pscustomobject]@{ Reason = "TLS_SECURITY"; ExitCode = 60 }
                }
            }
        }
        if ($current -is [System.Net.Sockets.SocketException]) {
            switch ($current.SocketErrorCode) {
                ([System.Net.Sockets.SocketError]::HostNotFound) {
                    return [pscustomobject]@{ Reason = "DNS"; ExitCode = 6 }
                }
                ([System.Net.Sockets.SocketError]::NoData) {
                    return [pscustomobject]@{ Reason = "DNS"; ExitCode = 6 }
                }
                ([System.Net.Sockets.SocketError]::TryAgain) {
                    return [pscustomobject]@{ Reason = "DNS"; ExitCode = 6 }
                }
            }
            return [pscustomobject]@{ Reason = "CONNECTION"; ExitCode = 7 }
        }
        $current = $current.InnerException
    }
    return [pscustomobject]@{ Reason = "UNCLASSIFIED"; ExitCode = 1 }
}

try {
    Add-Type -AssemblyName System.Net.Http
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

    $requestJson = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($requestJson) -or $requestJson.Length -gt 1MB) {
        Stop-WithReason "CONFIGURATION" 2
    }
    $request = $requestJson | ConvertFrom-Json
    $methodText = ([string]$request.method).ToUpperInvariant()
    if ($methodText -notin @("GET", "POST")) {
        Stop-WithReason "CONFIGURATION" 2
    }
    if ($null -eq $request.PSObject.Properties["requestStage"] -or
        $null -eq $request.PSObject.Properties["timeoutSeconds"]) {
        Stop-WithReason "CONFIGURATION" 2
    }
    $requestStage = ([string]$request.requestStage).ToUpperInvariant()
    $timeoutText = [string]$request.timeoutSeconds
    if ($requestStage -notin @("TOKEN", "NOTAMS") -or
        $timeoutText -notin @("35", "120")) {
        Stop-WithReason "CONFIGURATION" 2
    }
    $timeoutSeconds = [int]$timeoutText

    $uri = [Uri]([string]$request.url)
    if (-not $uri.IsAbsoluteUri -or
        $uri.Scheme -cne "https" -or
        $uri.DnsSafeHost -ine $expectedHost -or
        $uri.Port -ne 443 -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        Stop-WithReason "CONFIGURATION" 2
    }
    if ($uri.AbsolutePath -eq "/v1/auth/token") {
        if ($methodText -cne "POST" -or
            -not [bool]$request.hasBody -or
            -not [string]::IsNullOrEmpty($uri.Query) -or
            $requestStage -cne "TOKEN" -or
            $timeoutSeconds -ne $tokenTimeoutSeconds) {
            Stop-WithReason "CONFIGURATION" 2
        }
    } elseif ($uri.AbsolutePath -eq "/nmsapi/v1/notams") {
        if ($methodText -cne "GET" -or
            [bool]$request.hasBody -or
            $uri.Query -cne "?location=KMEM" -or
            $requestStage -cne "NOTAMS" -or
            $timeoutSeconds -ne $notamsTimeoutSeconds) {
            Stop-WithReason "CONFIGURATION" 2
        }
    } else {
        Stop-WithReason "CONFIGURATION" 2
    }

    $bodyBytes = $null
    if ([bool]$request.hasBody) {
        $bodyBytes = [Convert]::FromBase64String([string]$request.bodyBase64)
        $bodyText = [Text.Encoding]::ASCII.GetString($bodyBytes)
        if ($bodyText -cne "grant_type=client_credentials") {
            Stop-WithReason "CONFIGURATION" 2
        }
    } elseif (-not [string]::IsNullOrEmpty([string]$request.bodyBase64)) {
        Stop-WithReason "CONFIGURATION" 2
    }

    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.CheckCertificateRevocationList = $true
    $handler.UseCookies = $false
    $handler.UseDefaultCredentials = $false
    $handler.PreAuthenticate = $false
    $handler.UseProxy = $true

    # GetSystemWebProxy honors this interactive task user's auto-detect, PAC,
    # manual, and advanced Windows Internet Options without exposing its URI.
    $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
    if ($null -ne $systemProxy) {
        $systemProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
        $handler.Proxy = $systemProxy
        $route = if ($systemProxy.IsBypassed($uri)) { "DIRECT" } else { "SYSTEM_PROXY" }
    } else {
        $handler.Proxy = $null
        $route = "DIRECT"
    }
    Write-SafeMarker "route" $route

    $client = New-Object System.Net.Http.HttpClient -ArgumentList @(,$handler)
    $client.Timeout = [TimeSpan]::FromSeconds($timeoutSeconds)
    $method = New-Object System.Net.Http.HttpMethod -ArgumentList @($methodText)
    $message = New-Object System.Net.Http.HttpRequestMessage -ArgumentList @($method, $uri)
    if ($null -ne $bodyBytes) {
        $message.Content = New-Object System.Net.Http.ByteArrayContent -ArgumentList @(,$bodyBytes)
    }

    foreach ($property in $request.headers.PSObject.Properties) {
        $name = [string]$property.Name
        $value = [string]$property.Value
        if ($name -notmatch "^[A-Za-z0-9!#`$%&'*+.^_``|~-]+$" -or
            $value.IndexOfAny([char[]]@(0, 10, 13)) -ge 0 -or
            $name -imatch "^(Connection|Content-Length|Host|Proxy-Authorization|Transfer-Encoding)$") {
            Stop-WithReason "CONFIGURATION" 2
        }
        if ($name -ieq "Content-Type") {
            if ($null -eq $message.Content -or
                -not $message.Content.Headers.TryAddWithoutValidation($name, $value)) {
                Stop-WithReason "CONFIGURATION" 2
            }
        } elseif (-not $message.Headers.TryAddWithoutValidation($name, $value)) {
            Stop-WithReason "CONFIGURATION" 2
        }
    }

    $timeoutSource = New-Object System.Threading.CancellationTokenSource
    $timeoutSource.CancelAfter([TimeSpan]::FromSeconds($timeoutSeconds))
    $response = $client.SendAsync(
        $message,
        [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
        $timeoutSource.Token
    ).GetAwaiter().GetResult()

    $responseStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $responseBuffer = New-Object System.IO.MemoryStream
    $buffer = New-Object byte[] 8192
    $total = 0
    while (($read = $responseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $total += $read
        if ($total -gt $responseLimitBytes) {
            Stop-WithReason "RESPONSE_TOO_LARGE" 1
        }
        $responseBuffer.Write($buffer, 0, $read)
    }

    $responseBytes = $responseBuffer.ToArray()
    $output = [Console]::OpenStandardOutput()
    if ($responseBytes.Length -gt 0) {
        $output.Write($responseBytes, 0, $responseBytes.Length)
    }
    $statusText = "`n$statusMarker$([int]$response.StatusCode)`n"
    $statusBytes = [Text.Encoding]::ASCII.GetBytes($statusText)
    $output.Write($statusBytes, 0, $statusBytes.Length)
    $output.Flush()
} catch {
    $failure = Get-SafeFailure $_.Exception
    Stop-WithReason $failure.Reason $failure.ExitCode
} finally {
    if ($null -ne $responseBuffer) { $responseBuffer.Dispose() }
    if ($null -ne $responseStream) { $responseStream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $message) { $message.Dispose() }
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
    if ($null -ne $timeoutSource) { $timeoutSource.Dispose() }
}
