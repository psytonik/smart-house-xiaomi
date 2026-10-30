import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AuthError,
  addCamera,
  getCameras,
  listXiaomiDevices,
  xiaomiLogin,
  type Cameras as CamerasState,
  type LoginResult,
  type XiaomiDevice,
} from "../api";
import { REGIONS, STREAM_NAME, regionLabel, streamName } from "../cameras";

interface Props {
  onClose: () => void;
  onAuthError: () => void;
}

type View =
  | { id: "list" }
  | { id: "signin" }
  | { id: "captcha"; image: string }
  | { id: "verify"; target: string }
  | { id: "find"; account: string };

type Found = XiaomiDevice & { region: string };

const keyOf = (d: Found) => `${d.region}:${d.did}`;

const STEPS = ["Sign in to Mi Home", "Choose a camera"];

/**
 * Cameras: what go2rtc has, and the way to add one: sign in to Mi Home (with the captcha or code it may ask for),
 * find the cameras of the account in every region, give one a name. The browser never sends a stream source;
 * the backend takes it from go2rtc (ADR 0013).
 */
export function Cameras({ onClose, onAuthError }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [cams, setCams] = useState<CamerasState | null>(null);
  const [view, setView] = useState<View>({ id: "list" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [cardError, setCardError] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<Record<string, string>>({});
  // A search that was started before a newer one (or before the dialog closed) must not overwrite the newer answer.
  const searchId = useRef(0);

  useEffect(() => {
    const dlg = dialog.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);

  const fail = (e: unknown) => {
    if (e instanceof AuthError) onAuthError();
    else setError(e instanceof Error ? e.message : "Something went wrong.");
  };

  useEffect(() => {
    getCameras().then(setCams).catch(fail);
    return () => {
      searchId.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function go(next: View) {
    setError("");
    setView(next);
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function search(account: string) {
    const mine = ++searchId.current;
    setFound(null);
    setError("");
    // The region of an account is not something people remember, so every region is asked at once.
    const answers = await Promise.allSettled(REGIONS.map((r) => listXiaomiDevices(account, r.id).then((ds) => ds.map((d) => ({ ...d, region: r.id })))));
    if (mine !== searchId.current) return;
    const auth = answers.find((a) => a.status === "rejected" && a.reason instanceof AuthError);
    if (auth) return onAuthError();
    const devices = answers.flatMap((a) => (a.status === "fulfilled" ? a.value : []));
    const failed = answers.filter((a): a is PromiseRejectedResult => a.status === "rejected");
    // Some regions failing is normal (the account has nothing there). Only report it when nothing could be read at all.
    if (devices.length === 0 && failed.length === answers.length) {
      setError(failed[0]?.reason instanceof Error ? failed[0].reason.message : "Couldn't reach Mi Home.");
    }
    setFound(devices);
  }

  function openFind(account: string) {
    go({ id: "find", account });
    void search(account);
  }

  function startAdding() {
    const first = cams?.accounts[0];
    if (first) openFind(first);
    else go({ id: "signin" });
  }

  async function signedIn(result: LoginResult) {
    if (result.status === "captcha") return go({ id: "captcha", image: result.image });
    if (result.status === "verify") return go({ id: "verify", target: result.target });
    const before = cams?.accounts ?? [];
    const fresh = await getCameras();
    setCams(fresh);
    const account = fresh.accounts.find((a) => !before.includes(a)) ?? fresh.accounts[0];
    if (!account) {
      go({ id: "signin" });
      setError("Mi Home accepted the sign-in, but go2rtc doesn't list the account. Try again.");
      return;
    }
    openFind(account);
  }

  function submitCredentials(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read from the form and never keep the password in React state.
    const form = new FormData(e.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!username || !password) return;
    void run(async () => signedIn(await xiaomiLogin({ username, password })));
  }

  function submitCode(field: "captcha" | "verify") {
    return (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const value = String(new FormData(e.currentTarget).get("code") ?? "").trim();
      if (!value) return;
      void run(async () => signedIn(await xiaomiLogin(field === "captcha" ? { captcha: value } : { verify: value })));
    };
  }

  async function add(device: Found, name: string) {
    const key = keyOf(device);
    if (view.id !== "find") return;
    const account = view.account;
    setAdding(key);
    setCardError((c) => ({ ...c, [key]: "" }));
    try {
      const created = await addCamera({ account, region: device.region, did: device.did, name });
      setAdded((a) => ({ ...a, [key]: created.name }));
      setCams(await getCameras());
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setCardError((c) => ({ ...c, [key]: e instanceof Error ? e.message : "Couldn't add the camera." }));
    } finally {
      setAdding(null);
    }
  }

  const taken = cams?.streams.map((s) => s.name) ?? [];
  const active = cams?.streams.find((s) => s.active)?.name;
  const step = view.id === "find" ? 1 : view.id === "list" ? -1 : 0;
  const anyAdded = Object.keys(added).length > 0;

  return (
    <dialog ref={dialog} className="viewer cameras" aria-labelledby="cameras-title" onClose={onClose} onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
      <div className="viewer-body">
        <header className="cam-head">
          <h2 id="cameras-title">Cameras</h2>
          <button type="button" className="quiet" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </header>

        {step >= 0 && (
          <ol className="cam-steps" aria-label="Steps">
            {STEPS.map((label, i) => (
              <li key={label} aria-current={i === step ? "step" : undefined} className={i < step ? "done" : undefined}>
                <span className="n" aria-hidden="true">
                  {i < step ? "✓" : i + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        )}

        {error && view.id !== "find" && (
          <p className="cam-error" role="alert">
            {error}
          </p>
        )}

        {view.id === "list" && (
          <div className="cam-section">
            {cams === null ? (
              <p role="status" className="cam-muted">
                Loading…
              </p>
            ) : (
              <>
                {cams.streams.length === 0 ? (
                  <p className="cam-muted">No cameras in go2rtc yet. Add the first one.</p>
                ) : (
                  <ul className="cam-list">
                    {cams.streams.map((s) => (
                      <li key={s.name}>
                        <span className="cam-name">{s.name}</span>
                        <span className={`cam-badge${s.active ? " on" : ""}`}>{s.active ? "Shown in this app" : "Ready in go2rtc"}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="cam-muted">
                  {cams.accounts.length > 0 ? `Signed in to Mi Home (account ${cams.accounts.join(", ")}).` : "Not signed in to Mi Home yet."}
                </p>
                <div className="cam-actions">
                  <button type="button" className="primary" onClick={startAdding}>
                    Add a camera
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {view.id === "signin" && (
          <form className="cam-section cam-form" onSubmit={submitCredentials}>
            <p className="cam-muted">
              Use the account you sign in with in the Mi Home app. Your password is passed to go2rtc and is not stored; go2rtc keeps only a sign-in token in go2rtc.yaml.
            </p>
            <label htmlFor="mi-user">Email, phone or Xiaomi ID</label>
            <input id="mi-user" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required />
            <label htmlFor="mi-pass">Password</label>
            <input id="mi-pass" name="password" type="password" autoComplete="current-password" required />
            <div className="cam-actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <button type="button" className="quiet" onClick={() => go({ id: "list" })} disabled={busy}>
                Back
              </button>
            </div>
          </form>
        )}

        {view.id === "captcha" && (
          <form className="cam-section cam-form" onSubmit={submitCode("captcha")}>
            <p className="cam-muted">Mi Home wants to check that you're a person. Type the characters from the picture.</p>
            <img className="cam-captcha" src={`data:image/jpeg;base64,${view.image}`} alt="Captcha: the characters to type below" />
            <label htmlFor="mi-captcha">Characters</label>
            <input id="mi-captcha" name="code" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus required />
            <div className="cam-actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Checking…" : "Continue"}
              </button>
              <button type="button" className="quiet" onClick={() => go({ id: "signin" })} disabled={busy}>
                Start over
              </button>
            </div>
          </form>
        )}

        {view.id === "verify" && (
          <form className="cam-section cam-form" onSubmit={submitCode("verify")}>
            <p className="cam-muted">
              Mi Home sent a verification code to <strong>{view.target}</strong>. Enter it to finish signing in.
            </p>
            <label htmlFor="mi-code">Verification code</label>
            <input id="mi-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} autoFocus required />
            <div className="cam-actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Checking…" : "Continue"}
              </button>
              <button type="button" className="quiet" onClick={() => go({ id: "signin" })} disabled={busy}>
                Start over
              </button>
            </div>
          </form>
        )}

        {view.id === "find" && (
          <div className="cam-section">
            {cams && cams.accounts.length > 1 ? (
              <div className="cam-account">
                <label htmlFor="mi-account">Mi Home account</label>
                <select id="mi-account" value={view.account} onChange={(e) => openFind(e.target.value)}>
                  {cams.accounts.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="cam-muted">Cameras in Mi Home account {view.account}.</p>
            )}

            {found === null && (
              <p role="status" className="cam-muted">
                Looking in every Mi Home region…
              </p>
            )}

            {found !== null && error && (
              <p className="cam-error" role="alert">
                {error}
              </p>
            )}

            {found !== null && found.length === 0 && !error && (
              <p className="cam-muted">No cameras found. Check that the camera is set up in the Mi Home app under this account, then search again.</p>
            )}

            {found !== null && found.length > 0 && (
              <ul className="cam-found">
                {found.map((d) => {
                  const key = keyOf(d);
                  const name = names[key] ?? streamName(d.name, taken);
                  const clash = taken.includes(name);
                  const valid = STREAM_NAME.test(name);
                  const done = added[key];
                  return (
                    <li key={key}>
                      <div className="cam-found-head">
                        <strong>{d.name}</strong>
                        <span className="cam-muted">
                          {[d.model, d.ip, regionLabel(d.region)].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      {done ? (
                        <p className="cam-ok" role="status">
                          Added as <code>{done}</code>.
                        </p>
                      ) : (
                        <form
                          className="cam-add"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (valid && !clash) void add(d, name);
                          }}
                        >
                          <label htmlFor={`name-${key}`}>Name in go2rtc</label>
                          <div className="cam-add-row">
                            <input
                              id={`name-${key}`}
                              value={name}
                              onChange={(e) => setNames((n) => ({ ...n, [key]: e.target.value }))}
                              autoCapitalize="none"
                              spellCheck={false}
                              aria-invalid={!valid || clash || undefined}
                              aria-describedby={`hint-${key}`}
                            />
                            <button type="submit" className="primary" disabled={!valid || clash || adding !== null}>
                              {adding === key ? "Adding…" : "Add"}
                            </button>
                          </div>
                          <p id={`hint-${key}`} className={valid && !clash && !cardError[key] ? "cam-muted" : "cam-error"} role={cardError[key] ? "alert" : undefined}>
                            {cardError[key] ||
                              (clash ? "That name is already used." : valid ? "Lowercase letters, digits, - and _." : "Use lowercase letters, digits, - and _ (up to 40).")}
                          </p>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {anyAdded && (
              <p className="cam-note">
                The camera is now in go2rtc and saved in go2rtc.yaml. This app still shows and records{" "}
                {active ? <code>{active}</code> : "its current camera"}; switching it to another camera isn't built yet.
              </p>
            )}

            <div className="cam-actions">
              <button type="button" className="quiet" onClick={() => go({ id: "list" })}>
                Back to cameras
              </button>
              <button type="button" className="quiet" onClick={() => void search(view.account)} disabled={found === null}>
                Search again
              </button>
              <button type="button" className="quiet" onClick={() => go({ id: "signin" })}>
                Use another account
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
