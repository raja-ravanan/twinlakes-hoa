/* ═══════════════════════════════════════════════════════
   TWIN LAKES AT FLOYDS FORK — script.js
   ═══════════════════════════════════════════════════════ */

/* Navigate between pages */
function go(pageName) {
  document.querySelectorAll('.page').forEach(function(p) {
    p.classList.remove('active');
  });
  document.querySelectorAll('.nav-links a').forEach(function(a) {
    a.classList.remove('active');
  });

  var page = document.getElementById('page-' + pageName);
  var link = document.getElementById('nav-' + pageName);
  if (page) page.classList.add('active');
  if (link) link.classList.add('active');

  /* Close mobile menu on navigation */
  var navLinks = document.getElementById('nav-links');
  if (navLinks) navLinks.classList.remove('open');

  window.scrollTo(0, 0);
}

/* Toggle mobile hamburger menu */
function toggleMenu() {
  var navLinks = document.getElementById('nav-links');
  if (navLinks) navLinks.classList.toggle('open');
}

/* Contact form submission
 * Currently shows a success message locally.
 * To wire up real email delivery, sign up at formspree.io,
 * get your form ID, and replace the showSuccess() call below
 * with the fetch block shown in the comments.
 */
function submitForm() {
  var name    = document.getElementById('f-name').value.trim();
  var email   = document.getElementById('f-email').value.trim();
  var message = document.getElementById('f-message').value.trim();

  if (!name || !email || !message) {
    alert('Please fill in your name, email, and message before sending.');
    return;
  }

  /* ── FORMSPREE: uncomment and fill in your form ID to activate ──
  fetch('https://formspree.io/f/YOUR_FORM_ID', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:    name,
      email:   email,
      address: document.getElementById('f-addr').value.trim(),
      sendTo:  document.getElementById('f-to').value,
      subject: document.getElementById('f-subject').value.trim(),
      message: message
    })
  })
  .then(function(response) {
    if (response.ok) { showSuccess(); }
    else { alert('Something went wrong. Please try again or email us directly.'); }
  })
  .catch(function() {
    alert('Could not send message. Please check your connection and try again.');
  });
  return;
  ── ──────────────────────────────────────────────────────────── */

  showSuccess();
}

function showSuccess() {
  var msg = document.getElementById('success-msg');
  if (msg) msg.style.display = 'block';

  ['f-name', 'f-addr', 'f-email', 'f-subject', 'f-message'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });

  var sel = document.getElementById('f-to');
  if (sel) sel.selectedIndex = 0;
}
