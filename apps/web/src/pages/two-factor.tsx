import QRCode from "qrcode";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { post } from "../api";
import { useSession } from "../session";
import { Button, ErrorBox, Field } from "../ui";

/** TOTP enrollment / management card (also used as the forced-enrollment screen). */
export function TwoFactorCard() {
  const { me, refresh } = useSession();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disable, setDisable] = useState({ password: "", code: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad stack">
      <div className="row">
        <ShieldCheck size={18} />
        <h2>Two-factor authentication</h2>
        <span className={`badge ${me?.totpEnabled ? "green" : ""}`}>{me?.totpEnabled ? "on" : "off"}</span>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {recovery ? (
        <div className="stack">
          <div className="alert warn">Save these recovery codes somewhere safe. Each works once if you lose your device. They will not be shown again.</div>
          <pre className="json mono">{recovery.join("\n")}</pre>
          <Button variant="primary" onClick={() => (setRecovery(null), void refresh())}>
            I saved them
          </Button>
        </div>
      ) : me?.totpEnabled ? (
        <>
          <div className="muted">Sign-ins with a password require a code from your authenticator app. Recovery codes left: {me.recoveryCodesLeft}.</div>
          {!me.require2fa && (
            <>
              <Field label="Password">
                <input className="input" type="password" autoComplete="current-password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} />
              </Field>
              <Field label="Current code">
                <input className="input mono" inputMode="numeric" value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value })} />
              </Field>
              <Button variant="danger" loading={busy} onClick={() => run(async () => (await post("/api/auth/2fa/disable", disable), await refresh()))}>
                Turn off two-factor
              </Button>
            </>
          )}
        </>
      ) : setup ? (
        <>
          <div className="muted">Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis…), or enter the key manually, then type the 6-digit code.</div>
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ background: "white", padding: 8, borderRadius: 8, alignSelf: "flex-start" }} />
          <Field label="Manual key">
            <input className="input mono" readOnly value={setup.secret} onFocus={(e) => e.target.select()} />
          </Field>
          <Field label="Code from the app">
            <input className="input mono" autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} />
          </Field>
          <Button variant="primary" loading={busy} disabled={code.length < 6} onClick={() => run(async () => setRecovery((await post<{ recoveryCodes: string[] }>("/api/auth/2fa/confirm", { code })).recoveryCodes))}>
            Confirm and turn on
          </Button>
        </>
      ) : (
        <>
          <div className="muted">Protect your account with a time-based one-time code in addition to your password.</div>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              run(async () => {
                const r = await post<{ secret: string; otpauthUri: string }>("/api/auth/2fa/setup");
                setSetup({ ...r, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 360 }) });
              })
            }
          >
            Set up two-factor
          </Button>
        </>
      )}
    </div>
  );
}

/** Full-screen gate when the workspace requires 2FA and the user has not enrolled. */
export function TwoFactorRequiredPage() {
  return (
    <div className="auth">
      <div className="stack" style={{ width: "min(460px, 100%)" }}>
        <div className="alert info">Your workspace requires two-factor authentication. Set it up to continue.</div>
        <TwoFactorCard />
      </div>
    </div>
  );
}
