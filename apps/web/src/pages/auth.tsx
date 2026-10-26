import { Bot, CheckCircle2, KeyRound, ShieldCheck, Workflow, Zap } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { get, post, setCsrf } from "../api";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { Button, ErrorBox, Field } from "../ui";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { refresh } = useSession();
  const { navigate, search } = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [sso, setSso] = useState<{ label: string } | null>(null);
  const [error, setError] = useState<unknown>(search.get("sso_error") ? new Error(`Single sign-on failed: ${search.get("sso_error")}`) : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void get<{ sso: { label: string } | null }>("/api/meta").then((m) => setSso(m.sso)).catch(() => undefined);
  }, []);

  const finish = async (csrf: string) => {
    setCsrf(csrf);
    await refresh();
    navigate("/", { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        const r = await post<{ csrfToken: string }>("/api/auth/login/mfa", { mfaToken, code });
        await finish(r.csrfToken);
        return;
      }
      const r = await post<{ csrfToken: string; mfaRequired?: boolean; mfaToken?: string }>(mode === "login" ? "/api/auth/login" : "/api/auth/register", { email, password, name });
      if (r.mfaRequired && r.mfaToken) {
        setMfaToken(r.mfaToken);
        return;
      }
      await finish(r.csrfToken);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-split">
      <aside className="auth-art" aria-hidden="true">
        <div className="row" style={{ gap: 11, fontWeight: 750, fontSize: 16 }}>
          <span className="brand-mark" style={{ background: "rgba(255,255,255,0.18)", boxShadow: "none" }}>
            <Zap size={17} fill="currentColor" />
          </span>
          {document.title || "Automation Studio"}
        </div>
        <div>
          <h2>Automate the busywork. Keep humans in charge.</h2>
          <ul>
            <li>
              <Workflow size={18} /> Visual workflows with branches, loops and retries
            </li>
            <li>
              <Bot size={18} /> AI steps on local or hosted models
            </li>
            <li>
              <CheckCircle2 size={18} /> Human approval before anything goes out
            </li>
            <li>
              <ShieldCheck size={18} /> Encrypted connections, 2FA and SSO
            </li>
          </ul>
          <div className="flow">
            <span>Form submitted</span>→<span>AI scores lead</span>→<span>Approve</span>→<span>Send email</span>
          </div>
        </div>
        <div style={{ opacity: 0.75, fontSize: 13 }}>Runs on your own infrastructure.</div>
      </aside>
      <div className="auth-form">
      <form className="card stack" onSubmit={submit} style={{ gap: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark">
            <Zap size={16} fill="currentColor" />
          </span>
          <h1>{mfaToken ? "Two-factor authentication" : mode === "login" ? "Sign in" : "Create your account"}</h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {mfaToken ? "Enter the 6-digit code from your authenticator app, or one of your recovery codes." : mode === "login" ? "Automate your business workflows." : "Your account gets its own workspace. You become its owner."}
        </p>
        {error ? <ErrorBox error={error} /> : null}
        {mfaToken ? (
          <Field label="Code">
            <input className="input mono" autoFocus inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value.trim())} />
          </Field>
        ) : (
          <>
            {mode === "register" && (
              <Field label="Name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </Field>
            )}
            <Field label="Email">
              <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </Field>
            <Field label="Password" help={mode === "register" ? "At least 10 characters." : undefined}>
              <input className="input" type="password" required minLength={mode === "register" ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </Field>
          </>
        )}
        <Button variant="primary" type="submit" loading={busy}>
          {mfaToken ? "Verify" : mode === "login" ? "Sign in" : "Create account"}
        </Button>
        {mfaToken && (
          <Button type="button" variant="ghost" onClick={() => (setMfaToken(null), setCode(""))}>
            Back
          </Button>
        )}
        {!mfaToken && sso && mode === "login" && (
          <a className="btn" href="/api/auth/sso/start">
            <KeyRound size={15} /> {sso.label}
          </a>
        )}
        {!mfaToken && (
          <div className="faint" style={{ textAlign: "center" }}>
            {mode === "login" ? (
              <>
                No account? <Link to="/register">Create one</Link>
              </>
            ) : (
              <>
                Already registered? <Link to="/login">Sign in</Link>
              </>
            )}
          </div>
        )}
      </form>
      </div>
    </div>
  );
}
