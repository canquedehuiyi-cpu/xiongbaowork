/** Why Connect with OpenBot Desktop did not connect this browser, one plain sentence per code: OpenBot Desktop's own
 * error codes, and the Recorder's (no answer, the policy, an address it cannot use, OpenBot not taking Desktop's code). */
const SENTENCES: Record<string, string> = {
  "origin-not-allowed":
    "XiongBao Work Desktop does not recognise this copy of the Recorder. Connect from XiongBao Work in your browser instead.",
  "not-installed":
    "XiongBao Work Desktop has not set up XiongBao Work on this computer yet. Finish setting it up in XiongBao Work Desktop, then try again.",
  "not-running":
    "XiongBao Work is not running in XiongBao Work Desktop. Open XiongBao Work Desktop, then try again.",
  "not-signed-in":
    "XiongBao Work Desktop is not signed in to your organization. Sign in again in XiongBao Work Desktop, then try again.",
  "organization-unavailable":
    "XiongBao Work Desktop cannot hand over your organization sign-in right now. Try again later.",
  "handoff-failed":
    "XiongBao Work did not give XiongBao Work Desktop a code to connect with. Try again.",
  "timed-out": "XiongBao Work Desktop did not answer in time. Try again.",
  "no-answer": "XiongBao Work Desktop did not answer. Open it, then try again.",
  "host-failed":
    "XiongBao Work Desktop ran into a problem while answering. Try again, or connect from XiongBao Work in your browser.",
  "unknown-message":
    "This version of XiongBao Work Desktop does not understand the Recorder. Update XiongBao Work Desktop, then try again.",
  "policy-invalid":
    "Your organization's Recorder policy names a XiongBao Work address the Recorder cannot use. Ask your IT team.",
  "pinned-elsewhere":
    "Your organization connects the Recorder to a different XiongBao Work. Connect from that XiongBao Work instead.",
  "invalid-address":
    "XiongBao Work Desktop answered with an address the Recorder cannot use. Connect from XiongBao Work in your browser instead.",
  "exchange-refused":
    "XiongBao Work did not accept the code XiongBao Work Desktop gave the Recorder. Try again.",
  "openbot-unreachable":
    "XiongBao Work did not answer. Make sure XiongBao Work is running in XiongBao Work Desktop, then try again.",
};

const UNKNOWN =
  "XiongBao Work Desktop could not connect this browser. Try again, or connect from XiongBao Work in your browser.";

export function desktopSentence(code: string): string {
  return Object.hasOwn(SENTENCES, code) ? (SENTENCES[code] as string) : UNKNOWN;
}
