import { Zap } from "lucide-react";
import { useState, type FormEvent } from "react";
import { post, setCsrf } from "../api";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { Button, ErrorBox, Field } from "../ui";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const { refresh } = useSession();
  const { navigate } = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ csrfToken: string }>(mode === "login" ? "/api/auth/login" : "/api/auth/register", { email, password, name });
      setCsrf(r.csrfToken);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit} style={{ gap: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark">
            <Zap size={16} fill="currentColor" />
          </span>
          <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {mode === "login" ? "Automate your business workflows." : "Your account gets its own workspace. You become its owner."}
        </p>
        {error ? <ErrorBox error={error} /> : null}
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
        <Button variant="primary" type="submit" loading={busy}>
          {mode === "login" ? "Sign in" : "Create account"}
        </Button>
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
      </form>
    </div>
  );
}
