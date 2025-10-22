(() => {
  const btn = document.getElementById('adminSignOutBtn');
  if (!btn) return;
  if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) return;
  const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await supabase.auth.signOut();
    } catch {}
    const redirect = encodeURIComponent('/admin');
    window.location.replace(`/login.html?redirect=${redirect}`);
  });
})();

