import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import * as Ic from './Icons.jsx';
import { usePersisted } from './store.js';
import {
  parseUpi, validateAmount, formatINR, telHref, CARRIERS, carrierSupported, makeRef, upiLink, initials,
  groupByDay, isValidVpa, USSD_SEND, USSD_BALANCE, USSD_MENU, MAX_AMOUNT,
} from './lib.js';

const DEMO_START = 12480.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function useToast() {
  const [t, setT] = useState('');
  const timer = useRef();
  const show = useCallback((m) => { setT(m); clearTimeout(timer.current); timer.current = setTimeout(() => setT(''), 2200); }, []);
  return [t, show];
}

function useTheme() {
  const [theme, setTheme] = usePersisted('theme', 'auto');
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'auto' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0d0b1a' : '#5b3df5');
    };
    apply(); mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    addEventListener('online', a); addEventListener('offline', b);
    return () => { removeEventListener('online', a); removeEventListener('offline', b); };
  }, []);
  return on;
}

export default function App() {
  const [onboarded, setOnboarded] = usePersisted('onboarded', false);
  const [theme, setTheme] = useTheme();
  const [mode, setMode] = usePersisted('mode', 'demo');
  const [carrier, setCarrier] = usePersisted('carrier', 'airtel');
  const [history, setHistory] = usePersisted('history', []);
  const [balance, setBalance] = usePersisted('demoBalance', DEMO_START);
  const [myVpa, setMyVpa] = usePersisted('myVpa', 'manan@zeppay');
  const [myName, setMyName] = usePersisted('myName', 'You');
  const [tab, setTab] = useState('home');
  const [screen, setScreen] = useState(null); // {name, ...}
  const [toast, showToast] = useToast();
  const online = useOnline();
  const [installEvt, setInstallEvt] = useState(null);

  useEffect(() => {
    const h = (e) => { e.preventDefault(); setInstallEvt(e); };
    addEventListener('beforeinstallprompt', h);
    return () => removeEventListener('beforeinstallprompt', h);
  }, []);

  const supported = carrierSupported(carrier);
  const ctx = { mode, carrier, supported, history, setHistory, balance, setBalance, showToast, myVpa, myName, setScreen, online };

  const go = (s) => setScreen(s);
  const close = () => setScreen(null);

  if (!onboarded) return <Onboarding onDone={() => setOnboarded(true)} />;

  return (
    <div className="app">
      <div className="statusbar-fill" />
      {tab === 'home' && <HomeTab {...ctx} go={go} installEvt={installEvt} onInstall={async () => { installEvt.prompt(); await installEvt.userChoice; setInstallEvt(null); }} goTab={setTab} />}
      {tab === 'history' && <HistoryTab {...ctx} go={go} />}
      {tab === 'settings' && <SettingsTab {...ctx} theme={theme} setTheme={setTheme} setMode={setMode} setCarrier={setCarrier} setMyVpa={setMyVpa} setMyName={setMyName} onReset={() => { setHistory([]); setBalance(DEMO_START); showToast('Demo data reset'); }} onReplay={() => setOnboarded(false)} />}

      <nav className="tabbar" aria-label="Main">
        <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')} aria-label="Home"><Ic.Home /><span>Home</span></button>
        <button className="fab" onClick={() => go({ name: 'scan' })} aria-label="Scan QR"><Ic.Scan width={28} height={28} /></button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')} aria-label="History"><Ic.Clock /><span>History</span></button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')} aria-label="Settings"><Ic.Gear /><span>Settings</span></button>
      </nav>

      {screen?.name === 'scan' && <Scanner onClose={close} onResult={(p) => go({ name: 'pay', payee: p })} showToast={showToast} />}
      {screen?.name === 'pay' && <PayScreen {...ctx} payee={screen.payee} onClose={close} onStart={(p) => go({ name: 'session', kind: 'pay', payee: p })} />}
      {screen?.name === 'session' && <Session {...ctx} {...screen} onClose={close} />}
      {screen?.name === 'balance' && <Session {...ctx} kind="balance" onClose={close} />}
      {screen?.name === 'myqr' && <MyQr {...ctx} onClose={close} />}
      {screen?.name === 'receipt' && <Receipt tx={screen.tx} onClose={close} onAgain={() => go({ name: 'pay', payee: { vpa: screen.tx.vpa, name: screen.tx.name, amount: String(screen.tx.amount), note: screen.tx.note || '' } })} />}

      <div className={'toast' + (toast ? ' show' : '')} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

/* ---------- Onboarding ---------- */
const SLIDES = [
  { icon: <Ic.WifiOff width={44} height={44} />, t: 'Pay with zero data', d: 'ZepPay rides on *99#, the USSD service built into your SIM. No Wi-Fi, no mobile data.' },
  { icon: <Ic.Scan width={44} height={44} />, t: 'Scan. Confirm. Zep.', d: 'Scan any UPI QR, check the payee, and ZepPay lines up the whole *99# flow for you.' },
  { icon: <Ic.Shield width={44} height={44} />, t: 'Your PIN stays yours', d: 'The UPI PIN is never saved. History lives only on this device. No account, no tracking.' },
];
function Onboarding({ onDone }) {
  const [i, setI] = useState(0);
  const last = i === SLIDES.length - 1;
  return (
    <div className="onb">
      <button className="skip" onClick={onDone}>Skip</button>
      <div className="onb-hero">
        <div className="logo-big"><Ic.Bolt width={54} height={54} /></div>
        <h1 className="brand">ZepPay</h1>
        <p className="tag">Offline UPI payments</p>
      </div>
      <div className="onb-card" key={i}>
        <div className="onb-ic">{SLIDES[i].icon}</div>
        <h2>{SLIDES[i].t}</h2>
        <p>{SLIDES[i].d}</p>
      </div>
      <div className="dots">{SLIDES.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>
      <button className="btn primary" onClick={() => (last ? onDone() : setI(i + 1))}>{last ? 'Get started' : 'Next'} <Ic.Arrow width={20} height={20} /></button>
      <p className="fine">Demo build. No real money moves unless you switch to Live mode.</p>
    </div>
  );
}

/* ---------- Home ---------- */
const PEOPLE = [
  { name: 'Aarav Sharma', vpa: 'aarav.sharma@okaxis' },
  { name: 'Priya Singh', vpa: 'priya.singh@oksbi' },
  { name: 'Rohan Mehta', vpa: 'rohan.m@ybl' },
  { name: 'Simran Kaur', vpa: 'simran.kaur@okhdfcbank' },
  { name: 'Chai Sutta Bar', vpa: 'chaisuttabar@paytm' },
  { name: 'Campus Canteen', vpa: 'campuscanteen@icici' },
  { name: 'Dev Patel', vpa: 'devpatel22@okicici' },
  { name: 'Mom', vpa: 'mom.family@oksbi' },
];
const HUES = [252, 12, 164, 36, 200, 320, 90, 280];
const hue = (s) => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
function Avatar({ name, size = 48 }) {
  const h = hue(name);
  return <span className="av" style={{ width: size, height: size, fontSize: size * 0.36, background: `hsl(${h} 70% 92%)`, color: `hsl(${h} 55% 32%)` }}>{initials(name)}</span>;
}

function HomeTab({ mode, supported, carrier, history, balance, go, online, installEvt, onInstall, goTab, myName }) {
  const [vpa, setVpa] = useState('');
  const [showId, setShowId] = useState(false);
  const vpaOk = isValidVpa(vpa);
  const recent = history.slice(0, 3);
  const pay = (p) => go({ name: 'pay', payee: { name: '', amount: '', note: '', ...p } });
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <main className="page home">
      <section className="hdr">
        <div className="hdr-row">
          <div className="brandrow"><span className="logo-sm"><Ic.Bolt width={16} height={16} /></span><b>ZepPay</b></div>
          <span className={'status ' + (online ? '' : 'off')}><i />{online ? 'Online' : 'Offline mode'}</span>
        </div>
        <p className="greet">{greet}{myName && myName !== 'You' ? ', ' + myName.split(' ')[0] : ''}</p>
        <button className="searchbar" onClick={() => setShowId(true)} aria-label="Pay anyone"><Ic.User width={20} height={20} /><span>Pay anyone with a UPI ID</span></button>
      </section>

      <section className="acts">
        <button onClick={() => go({ name: 'scan' })}><span><Ic.Scan /></span>Scan any QR</button>
        <button onClick={() => setShowId(true)}><span><Ic.User /></span>To UPI ID</button>
        <button onClick={() => go({ name: 'myqr' })}><span><Ic.Qr /></span>My QR</button>
        <button onClick={() => go({ name: 'balance' })}><span><Ic.Wallet /></span>Balance</button>
      </section>

      {showId && (
        <div className="idbox">
          <form className="row-input" onSubmit={(e) => { e.preventDefault(); if (vpaOk) { pay({ vpa: vpa.trim() }); setShowId(false); setVpa(''); } }}>
            <input autoFocus aria-label="UPI ID" placeholder="name@bank" value={vpa} onChange={(e) => setVpa(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck="false" inputMode="email" />
            <button className="btn primary sm" disabled={!vpaOk} aria-label="Continue"><Ic.Arrow width={20} height={20} /></button>
          </form>
          {vpa && !vpaOk && <p className="err">Use the format name@bank.</p>}
        </div>
      )}

      <section className="netcard">
        <span className="netic"><Ic.WifiOff width={22} height={22} /></span>
        <div><b>Works with no data</b><small>Payments run over *99# on your SIM, {CARRIERS.find((c) => c.id === carrier)?.name} selected.</small></div>
      </section>
      {!supported && <div className="warn" role="alert"><Ic.Info width={20} height={20} /><div><b>Jio doesn't support *99#.</b> Use an Airtel, Vi or BSNL SIM for live payments. Demo mode still works.</div></div>}

      <h3 className="sec">People &amp; places</h3>
      <div className="people">
        {PEOPLE.map((p) => (
          <button key={p.vpa} className="person" aria-label={`Pay ${p.name}`} onClick={() => pay(p)}><Avatar name={p.name} size={56} /><span>{p.name.split(' ')[0]}</span></button>
        ))}
      </div>

      <section className="bankrow">
        <div><small>{mode === 'demo' ? 'Demo wallet balance' : 'Mode'}</small>{mode === 'demo' ? <b data-testid="balance">{formatINR(balance)}</b> : <b>Live *99#</b>}</div>
        <button onClick={() => go({ name: 'balance' })}>Check balance <Ic.Arrow width={16} height={16} /></button>
      </section>

      <div className="sechead"><h3 className="sec">Recent</h3>{history.length > 0 && <button onClick={() => goTab('history')}>See all</button>}</div>
      {recent.length === 0 ? <div className="empty small">No payments yet. Pick someone above or scan a QR.</div> : (
        <ul className="list">{recent.map((t) => (
          <li key={t.id}><button onClick={() => go({ name: 'receipt', tx: t })} className="tx">
            <Avatar name={t.name || t.vpa} />
            <span className="tx-m"><b>{t.name || t.vpa.split('@')[0]}</b><small>{t.status === 'success' ? 'Paid' : 'Failed'} · {new Date(t.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</small></span>
            <span className={'tx-a ' + t.status}>{formatINR(t.amount)}</span>
          </button></li>))}</ul>
      )}

      {installEvt && <button className="install" onClick={onInstall}><Ic.Download /> Add ZepPay to home screen</button>}
      <section>
        <h3 className="sec">How it works</h3>
        <ol className="steps">
          <li><span><b>One time:</b> dial <code>{USSD_MENU}</code> and link your bank.</span></li>
          <li><span><b>Scan</b> a shop's UPI QR or enter a UPI ID.</span></li>
          <li><span><b>Check</b> the payee and amount. ZepPay opens <code>{USSD_SEND}</code>.</span></li>
          <li><span><b>Enter your UPI PIN</b> on the bank prompt.</span></li>
        </ol>
      </section>
      <p className="fine">UPI is a trademark of NPCI. ZepPay is an independent project.</p>
    </main>
  );
}

/* ---------- Scanner ---------- */
function Scanner({ onClose, onResult, showToast }) {
  const video = useRef(); const canvas = useRef(); const fileRef = useRef();
  const [err, setErr] = useState(''); const [torch, setTorch] = useState(false); const [paste, setPaste] = useState('');
  const streamRef = useRef();

  const handleText = useCallback((text) => {
    const p = parseUpi(text);
    if (!p) { showToast('Not a UPI QR'); return false; }
    onResult(p); return true;
  }, [onResult, showToast]);

  useEffect(() => {
    let raf, alive = true;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setErr('Camera not available here. Upload a QR image or paste a UPI ID below.'); return; }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = s; video.current.srcObject = s; await video.current.play();
        const tick = () => {
          const v = video.current;
          if (v && v.readyState === 4) {
            const c = canvas.current; c.width = v.videoWidth; c.height = v.videoHeight;
            const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(v, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height);
            const r = jsQR(d.data, d.width, d.height, { inversionAttempts: 'dontInvert' });
            if (r?.data) { const p = parseUpi(r.data); if (p) { navigator.vibrate?.(30); onResult(p); return; } }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { setErr('Camera permission needed. You can upload a QR image or paste a UPI ID instead.'); }
    })();
    return () => { alive = false; cancelAnimationFrame(raf); streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [onResult]);

  const fromFile = (f) => {
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); const max = 1400; const k = Math.min(1, max / Math.max(img.width, img.height));
      c.width = img.width * k; c.height = img.height * k;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height);
      const r = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
      if (!r) showToast('No QR found in that image'); else handleText(r.data);
    };
    img.onerror = () => showToast('Could not read that image');
    img.src = URL.createObjectURL(f);
  };
  const toggleTorch = async () => {
    const t = streamRef.current?.getVideoTracks()[0];
    try { await t.applyConstraints({ advanced: [{ torch: !torch }] }); setTorch(!torch); } catch { showToast('Torch not supported'); }
  };
  return (
    <div className="sheet scan" role="dialog" aria-label="Scan QR">
      <video ref={video} playsInline muted className="cam" />
      <canvas ref={canvas} hidden />
      <div className="scrim" />
      <header className="sheet-top light"><button className="icon-btn" onClick={onClose} aria-label="Close"><Ic.Close /></button><b>Scan UPI QR</b><button className="icon-btn" onClick={toggleTorch} aria-label="Torch"><Ic.Flash style={{ opacity: torch ? 1 : 0.6 }} /></button></header>
      <div className="frame"><i /><i /><i /><i /><span className="laser" /></div>
      {err && <p className="cam-err">{err}</p>}
      <div className="scan-bottom">
        <input ref={fileRef} type="file" accept="image/*" hidden data-testid="qr-file" onChange={(e) => { fromFile(e.target.files[0]); e.target.value = ''; }} />
        <button className="btn glass" onClick={() => fileRef.current.click()}><Ic.Image width={20} height={20} /> Upload QR image</button>
        <form className="row-input dark" onSubmit={(e) => { e.preventDefault(); if (!handleText(paste)) setPaste(''); }}>
          <input aria-label="Paste UPI ID or link" placeholder="Paste UPI ID or upi:// link" value={paste} onChange={(e) => setPaste(e.target.value)} autoCapitalize="off" spellCheck="false" />
          <button className="btn primary sm" disabled={!paste.trim()} aria-label="Use"><Ic.Arrow width={20} height={20} /></button>
        </form>
      </div>
    </div>
  );
}

/* ---------- Pay form ---------- */
function PayScreen({ payee, onClose, onStart, mode, supported, balance }) {
  const [amount, setAmount] = useState(payee.amount || '');
  const [note, setNote] = useState(payee.note || '');
  const [confirmed, setConfirmed] = useState(false);
  const [touched, setTouched] = useState(false);
  const err = validateAmount(amount);
  const demoShort = mode === 'demo' && !err && Number(amount) > balance;
  const blocked = mode === 'live' && !supported;
  const canGo = !err && !demoShort && confirmed && !blocked;
  return (
    <div className="sheet" role="dialog" aria-label="Pay">
      <header className="sheet-top"><button className="icon-btn" onClick={onClose} aria-label="Back"><Ic.Back /></button><b>Pay</b><span style={{ width: 40 }} /></header>
      <div className="sheet-body">
        <div className="payee"><Avatar name={payee.name || payee.vpa} size={56} />
          <div><div className="pname">{payee.name || 'Unnamed payee'}</div><div className="pvpa" data-testid="payee-vpa">{payee.vpa}</div></div></div>
        <label className="amt">
          <span className="rs">₹</span>
          <input autoFocus inputMode="decimal" aria-label="Amount" placeholder="0" value={amount}
            onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ''); if ((v.match(/\./g) || []).length < 2) setAmount(v); setTouched(true); }} />
        </label>
        {(touched || amount) && (err || demoShort) && <p className="err center">{err || `Demo wallet has only ${formatINR(balance)}`}</p>}
        <div className="limit">Limit ₹1 to ₹{MAX_AMOUNT.toLocaleString('en-IN')} per payment via *99#</div>
        <div className="quick">{[100, 500, 1000, 2000].map((v) => <button key={v} onClick={() => { setAmount(String(v)); setTouched(true); }}>₹{v.toLocaleString('en-IN')}</button>)}</div>
        <input className="field" aria-label="Note" placeholder="Add a note (optional)" maxLength={50} value={note} onChange={(e) => setNote(e.target.value)} />
        <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>I've checked this is the right person to pay.</span></label>
        {blocked && <div className="warn"><Ic.Info width={20} height={20} /><div>Your carrier is set to Jio, which doesn't support *99#. Change it in Settings or use Demo mode.</div></div>}
      </div>
      <div className="sheet-foot">
        <button className="btn primary wide" disabled={!canGo} onClick={() => onStart({ ...payee, amount, note })}>Pay {!err && amount ? formatINR(amount) : ''} <Ic.Arrow width={20} height={20} /></button>
      </div>
    </div>
  );
}

/* ---------- USSD session (demo simulation or live handoff) ---------- */
function Session({ kind, payee, mode, onClose, setHistory, setBalance, balance, showToast, setScreen, supported }) {
  const isPay = kind === 'pay';
  const [phase, setPhase] = useState(mode === 'demo' ? 'connecting' : 'live'); // connecting|pin|working|done|fail|live
  const [steps, setSteps] = useState([]);
  const [pin, setPin] = useState('');
  const [result, setResult] = useState(null);
  const done = useRef(false);

  const finish = useCallback((status, reason = '') => {
    if (done.current) return; done.current = true;
    if (isPay) {
      const tx = { id: makeRef(), at: Date.now(), vpa: payee.vpa, name: payee.name, amount: Number(payee.amount), note: payee.note, status, reason, mode };
      setHistory((h) => [tx, ...h].slice(0, 200));
      if (status === 'success' && mode === 'demo') setBalance((b) => Math.round((b - tx.amount) * 100) / 100);
      setResult(tx);
    } else setResult({ amount: balance });
    setPhase(status === 'success' ? 'done' : 'fail');
  }, [isPay, payee, mode, setHistory, setBalance, balance]);

  useEffect(() => {
    if (mode !== 'demo') return;
    let dead = false;
    (async () => {
      const add = (s) => !dead && setSteps((x) => [...x, s]);
      add(`Dialling ${isPay ? USSD_SEND : USSD_BALANCE}`); await sleep(500);
      add('Reaching your bank through NPCI'); await sleep(600);
      if (isPay) { add(`Sending to ${payee.vpa}`); await sleep(450); }
      add('Bank is asking for your UPI PIN'); await sleep(350);
      if (!dead) setPhase('pin');
    })();
    return () => { dead = true; };
  }, [mode, isPay, payee]);

  const submitPin = useCallback(async (p) => {
    setPhase('working'); setSteps((x) => [...x, 'Verifying PIN']);
    await sleep(900);
    setPin('');
    if (p === '000000' || p === '0000') { finish('failed', 'Incorrect UPI PIN. 2 attempts left.'); return; }
    setSteps((x) => [...x, isPay ? 'Bank confirmed the debit' : 'Fetching balance']);
    await sleep(500);
    finish('success');
  }, [finish, isPay]);

  useEffect(() => { if (phase === 'pin' && pin.length === 6) submitPin(pin); }, [pin, phase, submitPin]);
  const press = (d) => { if (phase !== 'pin') return; navigator.vibrate?.(8); setPin((p) => (p.length < 6 ? p + d : p)); };

  const copyVpa = async () => { try { await navigator.clipboard.writeText(payee.vpa); showToast('UPI ID copied'); } catch { showToast('Copy not available'); } };
  const dialLive = () => { if (isPay) copyVpa(); location.href = telHref(isPay ? USSD_SEND : USSD_BALANCE); };

  return (
    <div className="sheet session" role="dialog" aria-label="Payment session">
      <header className="sheet-top"><button className="icon-btn" onClick={onClose} aria-label="Close"><Ic.Close /></button><b>{isPay ? 'Paying' : 'Balance'}</b><span className="chip">{mode === 'demo' ? 'Demo' : 'Live'}</span></header>
      <div className="sheet-body center">
        {isPay && <div className="amt-show"><small>to {payee.name || payee.vpa}</small><div>{formatINR(payee.amount)}</div></div>}
        {mode === 'demo' && (phase === 'connecting' || phase === 'pin' || phase === 'working') && (
          <ul className="log" aria-label="Session log">{steps.map((s, i) => <li key={i} className={i === steps.length - 1 && phase !== 'pin' ? 'now' : ''}><Ic.Check width={16} height={16} />{s}</li>)}</ul>
        )}
        {phase === 'pin' && (
          <div className="pinwrap">
            <p className="ask">Enter UPI PIN</p>
            <div className="pins" data-testid="pin-dots">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className={i < pin.length ? 'f' : ''} />)}</div>
            <div className="pad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => press(d)}>{d}</button>)}
              <button onClick={() => setPin('')} aria-label="Clear"><Ic.Close width={20} height={20} /></button>
              <button onClick={() => press('0')}>0</button>
              <button onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Backspace"><Ic.Delete width={22} height={22} /></button>
            </div>
            <p className="fine">Demo PIN: any 6 digits. Try 000000 to see a failure. Never saved.</p>
          </div>
        )}
        {phase === 'working' && <div className="spin" aria-label="Working" />}
        {phase === 'done' && (
          <div className="outcome ok"><div className="burst"><Ic.Check width={46} height={46} strokeWidth={3} /></div>
            <h2>{isPay ? 'Payment successful' : 'Balance'}</h2>
            {isPay ? <p className="ref">Ref {result.id}</p> : <div className="bal-big">{formatINR(balance)}</div>}
            {!isPay && <p className="fine">Simulated demo balance.</p>}
          </div>)}
        {phase === 'fail' && (
          <div className="outcome bad"><div className="burst"><Ic.Close width={46} height={46} strokeWidth={3} /></div>
            <h2>Payment failed</h2><p>{result?.reason}</p></div>)}
        {phase === 'live' && (
          <div className="live">
            <div className="livebox"><Ic.Phone width={34} height={34} />
              <h2>Continue in your dialer</h2>
              <p>ZepPay copies the UPI ID and opens <code>{isPay ? USSD_SEND : USSD_BALANCE}</code>. Paste the ID when asked, then enter the amount and your UPI PIN.</p></div>
            {isPay && <button className="btn ghost wide" onClick={copyVpa}><Ic.Copy width={20} height={20} /> Copy UPI ID: {payee.vpa}</button>}
            <button className="btn primary wide" disabled={!supported} onClick={() => { dialLive(); setPhase('ask'); }}><Ic.Phone width={20} height={20} /> Open dialer</button>
            {!supported && <p className="err center">Jio SIMs can't use *99#.</p>}
          </div>)}
        {phase === 'ask' && (
          <div className="live"><div className="livebox"><h2>Did it go through?</h2><p>Your bank sends the real confirmation. Tell ZepPay so history stays accurate.</p></div>
            {isPay ? <>
              <button className="btn primary wide" onClick={() => finish('success')}>Yes, payment done</button>
              <button className="btn ghost wide" onClick={() => finish('failed', 'Marked as not completed.')}>No, it failed</button>
              <button className="btn text wide" onClick={dialLive}>Open dialer again</button></> : <button className="btn primary wide" onClick={onClose}>Done</button>}
          </div>)}
      </div>
      {(phase === 'done' || phase === 'fail') && (
        <div className="sheet-foot col">
          {isPay && phase === 'done' && <button className="btn ghost wide" onClick={() => setScreen({ name: 'receipt', tx: result })}>View receipt</button>}
          {phase === 'fail' && isPay && <button className="btn ghost wide" onClick={() => setScreen({ name: 'pay', payee })}><Ic.Retry width={20} height={20} /> Try again</button>}
          <button className="btn primary wide" onClick={onClose}>Done</button>
        </div>)}
    </div>
  );
}

/* ---------- Receipt ---------- */
function Receipt({ tx, onClose, onAgain }) {
  const ok = tx.status === 'success';
  const when = new Date(tx.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const share = async () => {
    const text = `ZepPay ${ok ? 'paid' : 'attempted'} ${formatINR(tx.amount)} to ${tx.name || tx.vpa} on ${when}. Ref ${tx.id}`;
    try { if (navigator.share) await navigator.share({ text }); else await navigator.clipboard.writeText(text); } catch { /* cancelled */ }
  };
  return (
    <div className="sheet" role="dialog" aria-label="Receipt">
      <header className="sheet-top"><button className="icon-btn" onClick={onClose} aria-label="Close"><Ic.Close /></button><b>Receipt</b><button className="icon-btn" onClick={share} aria-label="Share"><Ic.Share /></button></header>
      <div className="sheet-body center">
        <div className={'outcome ' + (ok ? 'ok' : 'bad')}><div className="burst sm">{ok ? <Ic.Check width={34} height={34} strokeWidth={3} /> : <Ic.Close width={34} height={34} strokeWidth={3} />}</div>
          <div className="bal-big">{formatINR(tx.amount)}</div><p>{ok ? 'Paid to' : 'Failed to pay'} <b>{tx.name || tx.vpa}</b></p></div>
        <dl className="kv">
          <dt>UPI ID</dt><dd>{tx.vpa}</dd><dt>Date</dt><dd>{when}</dd><dt>Reference</dt><dd>{tx.id}</dd>
          <dt>Mode</dt><dd>{tx.mode === 'demo' ? 'Demo simulation' : 'Live *99#'}</dd>{tx.note && <><dt>Note</dt><dd>{tx.note}</dd></>}
          {tx.reason && <><dt>Reason</dt><dd>{tx.reason}</dd></>}
        </dl>
      </div>
      <div className="sheet-foot"><button className="btn primary wide" onClick={onAgain}><Ic.Retry width={20} height={20} /> Pay again</button></div>
    </div>
  );
}

/* ---------- History ---------- */
function HistoryTab({ history, go }) {
  const groups = useMemo(() => groupByDay(history), [history]);
  return (
    <main className="page">
      <header className="top"><h1 className="title">History</h1></header>
      {history.length === 0 ? <div className="empty"><Ic.Clock width={40} height={40} /><p>No payments yet</p><small>Your last 200 payments are kept on this device only.</small></div> :
        groups.map((g) => (
          <section key={g.label}><h3 className="sec">{g.label}</h3>
            <ul className="list">{g.items.map((t) => (
              <li key={t.id}><button onClick={() => go({ name: 'receipt', tx: t })} className="tx">
                <Avatar name={t.name || t.vpa} />
                <span className="tx-m"><b>{t.name || t.vpa.split('@')[0]}</b><small>{new Date(t.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })} · {t.mode === 'demo' ? 'Demo' : 'Live'}</small></span>
                <span className={'tx-a ' + t.status}>{t.status === 'success' ? '-' : ''}{formatINR(t.amount)}<small>{t.status === 'success' ? 'Paid' : 'Failed'}</small></span>
              </button></li>))}</ul></section>))}
    </main>
  );
}

/* ---------- My QR ---------- */
function MyQr({ myVpa, myName, onClose, showToast }) {
  const [src, setSrc] = useState('');
  const link = upiLink({ vpa: myVpa, name: myName === 'You' ? '' : myName });
  useEffect(() => { QRCode.toDataURL(link, { margin: 1, width: 560, color: { dark: '#1b1340', light: '#ffffff' }, errorCorrectionLevel: 'M' }).then(setSrc); }, [link]);
  const copy = async () => { try { await navigator.clipboard.writeText(myVpa); showToast('UPI ID copied'); } catch { showToast('Copy not available'); } };
  return (
    <div className="sheet" role="dialog" aria-label="My QR">
      <header className="sheet-top"><button className="icon-btn" onClick={onClose} aria-label="Close"><Ic.Close /></button><b>My QR</b><span style={{ width: 40 }} /></header>
      <div className="sheet-body center">
        <div className="qrcard">{src && <img src={src} alt="Your UPI QR code" width="260" height="260" />}<b>{myName}</b><span>{myVpa}</span></div>
        <p className="fine">Anyone can scan this to pay you with any UPI app. Edit your UPI ID in Settings.</p>
        <button className="btn ghost wide" onClick={copy}><Ic.Copy width={20} height={20} /> Copy UPI ID</button>
      </div>
    </div>
  );
}

/* ---------- Settings ---------- */
function SettingsTab({ theme, setTheme, mode, setMode, carrier, setCarrier, myVpa, setMyVpa, myName, setMyName, onReset, onReplay, history }) {
  const [vpaDraft, setVpaDraft] = useState(myVpa);
  const okVpa = isValidVpa(vpaDraft);
  return (
    <main className="page">
      <header className="top"><h1 className="title">Settings</h1></header>
      <h3 className="sec">Mode</h3>
      <div className="seg" role="radiogroup" aria-label="Mode">
        <button role="radio" aria-checked={mode === 'demo'} className={mode === 'demo' ? 'on' : ''} onClick={() => setMode('demo')}>Demo</button>
        <button role="radio" aria-checked={mode === 'live'} className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live *99#</button>
      </div>
      <p className="fine left">{mode === 'demo' ? 'Simulated session and wallet. Safe to explore.' : 'Opens your phone dialer with the real *99# code. Your bank handles the payment. Needs a SIM with voice signal.'}</p>

      <h3 className="sec">Appearance</h3>
      <div className="seg" role="radiogroup" aria-label="Theme">
        {[['auto', 'Auto', <Ic.Auto width={18} height={18} key="a" />], ['light', 'Light', <Ic.Sun width={18} height={18} key="l" />], ['dark', 'Dark', <Ic.Moon width={18} height={18} key="d" />]].map(([k, l, ic]) => (
          <button key={k} role="radio" aria-checked={theme === k} className={theme === k ? 'on' : ''} onClick={() => setTheme(k)}>{ic}{l}</button>))}
      </div>

      <h3 className="sec">Your SIM carrier</h3>
      <div className="chips">{CARRIERS.map((c) => <button key={c.id} className={'chipbtn' + (carrier === c.id ? ' on' : '')} onClick={() => setCarrier(c.id)}>{c.name}</button>)}</div>
      {!carrierSupported(carrier) && <p className="err">Jio doesn't support *99#. Live payments are disabled.</p>}

      <h3 className="sec">Your receiving details</h3>
      <input className="field" aria-label="Display name" value={myName} maxLength={30} onChange={(e) => setMyName(e.target.value)} placeholder="Display name" />
      <div className="row-input">
        <input aria-label="My UPI ID" value={vpaDraft} onChange={(e) => setVpaDraft(e.target.value)} autoCapitalize="off" spellCheck="false" />
        <button className="btn primary sm" disabled={!okVpa || vpaDraft === myVpa} onClick={() => setMyVpa(vpaDraft.trim())}>Save</button>
      </div>

      <h3 className="sec">Data</h3>
      <div className="card-list">
        <button className="rowbtn" onClick={onReplay}>Replay intro</button>
        <button className="rowbtn danger" onClick={onReset} disabled={!history.length}><Ic.Trash width={18} height={18} /> Reset demo wallet &amp; history</button>
      </div>
      <p className="fine left">ZepPay stores everything on this device only. No analytics, no accounts, no servers. Independent side project, not a registered payment service. Inspired by the open-source OffPay idea.</p>
      <p className="fine left">v1.0.0</p>
    </main>
  );
}
