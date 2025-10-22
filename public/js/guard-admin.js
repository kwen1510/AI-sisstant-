(() => {
  // Redirect unauthenticated users from /admin to /login.html
  const allowedDomain = (window.ADMIN_DOMAIN || 'ri.edu.sg').toLowerCase();

  function toLogin() {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
    window.location.replace(`/login.html?redirect=${redirect}`);
  }

  if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
    // If Supabase is not configured on the client, send to login
    toLogin();
    return;
  }

  const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  window.__supabaseClient = supabase;
  let currentSession = null;

  async function requireSession() {
    if (currentSession?.access_token) return currentSession;
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    currentSession = session;
    if (!session?.access_token) {
      throw new Error('Session missing access token');
    }
    return session;
  }

  function needsAuth(resource) {
    if (!resource) return false;
    // String URL
    if (typeof resource === 'string') {
      // Relative API route
      if (resource.startsWith('/api/')) return true;
      // Absolute URL to same origin
      try {
        const url = new URL(resource, window.location.href);
        return url.origin === window.location.origin && url.pathname.startsWith('/api/');
      } catch {
        return false;
      }
    }
    // Request instance
    if (typeof Request !== 'undefined' && resource instanceof Request) {
      try {
        const url = new URL(resource.url, window.location.href);
        return url.origin === window.location.origin && url.pathname.startsWith('/api/');
      } catch {
        return false;
      }
    }
    return false;
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    if (needsAuth(input)) {
      try {
        const session = await requireSession();
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined) || {});
        headers.set('Authorization', `Bearer ${session.access_token}`);
        init = { ...init, headers };
      } catch (err) {
        console.warn('Failed to attach auth header, redirecting to login:', err?.message || err);
        toLogin();
        throw err;
      }
    }
    return originalFetch(input, init);
  };

  (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const email = session?.user?.email?.toLowerCase() || '';
      const ok = Boolean(session && email.endsWith(`@${allowedDomain}`));
      if (!ok) return toLogin();
      currentSession = session;
      // Expose user for page scripts that might need it
      window.__supabaseUser = session.user;
    } catch {
      toLogin();
    }
  })();

  supabase.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    if (session?.user) {
      window.__supabaseUser = session.user;
    } else {
      toLogin();
    }
  });
})();
