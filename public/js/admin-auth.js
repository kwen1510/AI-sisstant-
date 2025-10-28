(() => {
  const normalizeDomainList = (input) => {
    if (Array.isArray(input)) return input;
    if (typeof input === 'string' && input.trim()) return [input];
    return [];
  };

  const allowedDomains = Array.from(new Set(
    [
      ...normalizeDomainList(window.ADMIN_ALLOWED_DOMAINS),
      window.ADMIN_DOMAIN,
      'ri.edu.sg',
      'schools.gov.sg',
      'ufinity.com'
    ].map(d => String(d || '').trim().toLowerCase()).filter(Boolean)
  ));

  const defaultDomainLabel = allowedDomains.join(', ');

  if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
    const e = document.getElementById('error');
    if (e) e.textContent = 'Missing Supabase config. Create /public/supabase-config.js from supabase-config.example.js.';
    return;
  }

  const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  const $ = (id) => document.getElementById(id);
  const emailEl = $('email');
  const sendBtn = $('sendCodeBtn');
  const otpSection = $('otpSection');
  const otpEl = $('otp');
  const verifyBtn = $('verifyBtn');
  const resendBtn = $('resendBtn');
  const signOutBtn = $('signOutBtn');
  const msg = $('msg');
  const error = $('error');
  const ok = $('ok');
  const cooldownSecDefault = 30;
  let cooldownTimer = null;
  let currentSession = null;

  otpEl?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      verifyBtn?.click();
    }
  });

  async function getSupabaseAccessToken() {
    if (currentSession?.access_token) {
      return currentSession.access_token;
    }
    const { data } = await supabase.auth.getSession();
    currentSession = data?.session || null;
    return currentSession?.access_token || null;
  }

  window.getSupabaseAccessToken = getSupabaseAccessToken;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(input, init = {}) {
    let url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input.url === 'string') {
      url = input.url;
    }

    if (url.startsWith('/api/')) {
      try {
        const token = await getSupabaseAccessToken();
        if (token) {
          const headers = new Headers(init.headers || {});
          headers.set('Authorization', `Bearer ${token}`);
          init = { ...init, headers };
        }
      } catch (err) {
        console.warn('⚠️ Failed to attach Supabase auth header:', err?.message || err);
      }
    }

    return originalFetch(input, init);
  };

  function setStatus({ message = '', err = '', success = '' } = {}) {
    msg.textContent = message;
    error.textContent = err;
    ok.textContent = success;
  }

  function isAllowed(email) {
    const v = String(email || '').trim().toLowerCase();
    return allowedDomains.some(domain => v.endsWith(`@${domain}`));
  }

  function startCooldown(sec = cooldownSecDefault) {
    let remaining = sec;
    resendBtn.disabled = true;
    resendBtn.classList.remove('hidden');
    resendBtn.textContent = `Resend in ${remaining}s`;
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(cooldownTimer);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend OTP';
      } else {
        resendBtn.textContent = `Resend in ${remaining}s`;
      }
    }, 1000);
  }

  function stopCooldown() {
    clearInterval(cooldownTimer);
    resendBtn.textContent = 'Resend OTP';
    resendBtn.disabled = false;
  }

  async function refreshSessionUI() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      otpSection.classList.add('hidden');
      sendBtn.classList.add('hidden');
      signOutBtn.classList.remove('hidden');
      emailEl.value = session.user.email || '';
      setStatus({ success: `Signed in as ${session.user.email}` });
    } else {
      signOutBtn.classList.add('hidden');
      sendBtn.classList.remove('hidden');
    }
  }

  const urlParams = new URLSearchParams(window.location.search);
  const redirectTo = urlParams.get('redirect') || '/admin';
  const firstLoginRedirect = window.ADMIN_FIRST_LOGIN_REDIRECT || null;
  const emailRedirectTarget = window.ADMIN_EMAIL_REDIRECT_TO || firstLoginRedirect || redirectTo;

  const toAbsoluteUrl = (value) => {
    try {
      return new URL(value, window.location.origin).href;
    } catch {
      return new URL('/admin', window.location.origin).href;
    }
  };

  const emailRedirectTo = toAbsoluteUrl(emailRedirectTarget);

  function resolvePostSignInDestination(session) {
    const user = session?.user;
    if (!user) return redirectTo;
    const createdAt = user.created_at;
    const lastSignInAt = user.last_sign_in_at;
    const isFirstLogin = Boolean(firstLoginRedirect && (!lastSignInAt || (createdAt && createdAt === lastSignInAt)));
    return isFirstLogin ? firstLoginRedirect : redirectTo;
  }

  async function recordLogin(session) {
    try {
      const user = session?.user;
      if (!user) return;
      await supabase.from('user_logins').insert({
        user_id: user.id,
        email: user.email,
        user_agent: navigator.userAgent || null
      });
    } catch (e) {
      console.warn('Login logging failed (non-blocking):', e?.message || e);
    }
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    currentSession = session || null;
    refreshSessionUI();
    if (event === 'SIGNED_IN') {
      await recordLogin(session);
      const destination = resolvePostSignInDestination(session);
      window.location.replace(destination);
    }
  });

  sendBtn?.addEventListener('click', async () => {
    setStatus({ message: 'Sending code…' });
    const email = emailEl.value;
    if (!isAllowed(email)) {
      setStatus({ err: `Only ${defaultDomainLabel} emails are allowed.` });
      return;
    }
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo
        }
      });
      if (err) throw err;
      setStatus({ success: 'OTP sent. Check your inbox.' });
      otpSection.classList.remove('hidden');
      otpEl.focus();
      try { window.localStorage.setItem('otp_email', email); } catch {}
      startCooldown();
    } catch (e) {
      setStatus({ err: e.message || 'Failed to send OTP' });
    }
  });

  resendBtn?.addEventListener('click', async () => {
    const email = emailEl.value || window.localStorage.getItem('otp_email');
    if (!isAllowed(email)) {
      setStatus({ err: `Only ${defaultDomainLabel} emails are allowed.` });
      return;
    }
    setStatus({ message: 'Resending code…' });
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo
        }
      });
      if (err) throw err;
      setStatus({ success: 'OTP resent. Check your inbox.' });
      startCooldown();
    } catch (e) {
      setStatus({ err: e.message || 'Failed to resend OTP' });
      stopCooldown();
    }
  });

  verifyBtn?.addEventListener('click', async () => {
    setStatus({ message: 'Verifying…' });
    const email = emailEl.value || window.localStorage.getItem('otp_email');
    const token = String(otpEl.value || '').trim();
    if (!isAllowed(email)) {
      setStatus({ err: `Only ${defaultDomainLabel} emails are allowed.` });
      return;
    }
    if (!token) {
      setStatus({ err: 'Enter the OTP code sent to your email.' });
      return;
    }
    try {
      const { error: err } = await supabase.auth.verifyOtp({
        email,
        token,
        type: 'email'
      });
      if (err) throw err;
      setStatus({ success: 'Signed in successfully.' });
      await refreshSessionUI();
      // onAuthStateChange will handle logging + redirect
    } catch (e) {
      setStatus({ err: e.message || 'Verification failed' });
    }
  });

  signOutBtn?.addEventListener('click', async () => {
    setStatus({ message: 'Signing out…' });
    try {
      await supabase.auth.signOut();
      setStatus({ success: 'Signed out.' });
      otpSection.classList.add('hidden');
      sendBtn.classList.remove('hidden');
    } catch (e) {
      setStatus({ err: e.message || 'Sign out failed' });
    }
  });

  // Initialize UI with current session if present
  (async () => {
    await refreshSessionUI();
    // If already signed in and allowed, go to admin or requested page
    const { data: { session } } = await supabase.auth.getSession();
    const email = session?.user?.email?.toLowerCase() || '';
    if (session && allowedDomains.some(domain => email.endsWith(`@${domain}`))) {
      const destination = resolvePostSignInDestination(session);
      window.location.replace(destination);
    }
  })();

  // Surface Supabase redirect errors if a magic link hits this page
  try {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const err = hash.get('error_description') || hash.get('error');
    if (err) setStatus({ err });
  } catch {}

  if (window.__ENABLE_ADMIN_AUTH_TESTING__) {
    window.__ADMIN_AUTH_TESTING__ = {
      allowedDomains,
      isAllowed,
      emailRedirectTo,
      resolvePostSignInDestination
    };
  }
})();
