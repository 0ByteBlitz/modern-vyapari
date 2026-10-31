import { execFile } from "child_process";

/**
 * Windows Hello gate (app-launch layer). Electron has no first-party binding
 * for this, and adding a native npm module means node-gyp/native compilation
 * — so this shells out from the main process to PowerShell, which invokes
 * the real OS prompt via WinRT's UserConsentVerifier (the same biometric/PIN
 * dialog Windows itself uses for e.g. Settings changes). No secret material
 * (private key, API keys) is passed to or read by PowerShell — this only
 * asks Windows "did the logged-in user just prove who they are," nothing
 * more. Windows-only; a no-op elsewhere (see requestVerification below).
 */

export type HelloAvailability = "available" | "unavailable" | "unsupported-platform";

export interface HelloResult {
  verified: boolean;
  availability: HelloAvailability;
  /** Raw WinRT result string (Verified / Canceled / DeviceBusy / ...), for diagnostics. */
  detail?: string;
}

const POWERSHELL_TIMEOUT_MS = 90_000; // generous — the user needs time to complete the biometric/PIN prompt

function runPowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        // A non-zero exit is expected for "not verified" outcomes — we parse
        // stdout either way rather than treating exit code as pass/fail.
        if (error && (error as any).killed) {
          reject(new Error("Windows Hello prompt timed out"));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
  });
}

// PowerShell can't natively `await` a WinRT IAsyncOperation — this is the
// standard community-published shim (via System.WindowsRuntimeSystemExtensions'
// AsTask) for bridging it to a blocking .Wait(). No credential material
// passes through any of this; it only touches Windows.Security.Credentials.UI.
const AWAIT_HELPER = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
Function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
`;

// Windows' foreground-lock heuristic normally stops a background process
// (our spawned powershell.exe) from stealing focus — the actual consent
// prompt is rendered by a separate system broker process, not powershell.exe
// itself, so it doesn't inherit the "started by the foreground process"
// exception and just flashes in the taskbar instead of popping to the front.
// AllowSetForegroundWindow(ASFW_ANY) grants ANY process permission to call
// SetForegroundWindow for its next window, which lets the broker's dialog
// come forward like a normal modal prompt. Well-known Win32 technique for
// exactly this "script triggers a UI that appears behind" symptom.
const ALLOW_FOREGROUND_HELPER = `
Add-Type -Name Win32Foreground -Namespace Hello -MemberDefinition '[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);'
[Hello.Win32Foreground]::AllowSetForegroundWindow(-1) | Out-Null
`;

/** Checks whether Windows Hello is actually set up on this device (a PIN or
 *  biometric must be configured in Windows Settings for it to be available). */
export async function checkAvailability(): Promise<HelloAvailability> {
  if (process.platform !== "win32") return "unsupported-platform";

  try {
    const script = `${AWAIT_HELPER}
$availability = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
Write-Output "AVAILABILITY:$availability"
`;
    const { stdout } = await runPowerShell(script);
    return /AVAILABILITY:Available/.test(stdout) ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Shows the real Windows Hello prompt and waits for the user's response.
 *  Fails open (verified: true) on non-Windows platforms — this is an
 *  additive layer on top of existing credential encryption, not a
 *  replacement for it, so it shouldn't lock out macOS/Linux users entirely. */
export async function requestVerification(reason: string): Promise<HelloResult> {
  if (process.platform !== "win32") {
    return { verified: true, availability: "unsupported-platform" };
  }

  const availability = await checkAvailability();
  if (availability !== "available") {
    return { verified: false, availability };
  }

  try {
    // PowerShell double-quoted string — escape embedded quotes only, `reason`
    // is a fixed string from our own code, never user/network input.
    const escapedReason = reason.replace(/"/g, '`"');
    const script = `${AWAIT_HELPER}${ALLOW_FOREGROUND_HELPER}
$result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync("${escapedReason}")) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output "RESULT:$result"
`;
    const { stdout } = await runPowerShell(script);
    const match = /RESULT:(\w+)/.exec(stdout);
    const result = match?.[1] ?? "Unknown";
    return { verified: result === "Verified", availability: "available", detail: result };
  } catch (err) {
    return {
      verified: false,
      availability: "available",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
