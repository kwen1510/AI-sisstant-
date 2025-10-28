// Copy this file to public/supabase-config.js and fill in your values.
// These values are safe to expose in the browser (anon key only).

window.SUPABASE_URL = 'https://gjpnneuindwpkpsdaiyu.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqcG5uZXVpbmR3cGtwc2RhaXl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEwNDQyMjQsImV4cCI6MjA3NjYyMDIyNH0.B8m7cfO-xouY4VbOgh7q8ptGztXPDnBvH-uFenjKbaM';

// Restrict client-side to admins only by domain (UX guard).
// Supabase should also be configured to allow only this domain for signups.
window.ADMIN_ALLOWED_DOMAINS = ['ri.edu.sg', 'schools.gov.sg', 'ufinity.com'];
window.ADMIN_DOMAIN = window.ADMIN_ALLOWED_DOMAINS[0];
window.ADMIN_FIRST_LOGIN_REDIRECT = 'https://ai-ttention.onrender.com/dashboard';
window.ADMIN_EMAIL_REDIRECT_TO = window.ADMIN_FIRST_LOGIN_REDIRECT;
