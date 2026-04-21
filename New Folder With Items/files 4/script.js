/* ═══════════════════════════════════════════════════════
   TWIN LAKES AT FLOYDS FORK — script.js
   ═══════════════════════════════════════════════════════ */

function go(pageName) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-links a').forEach(function(a) { a.classList.remove('active'); });
  var page = document.getElementById('page-' + pageName);
  var link = document.getElementById('nav-' + pageName);
  if (page) page.classList.add('active');
  if (link) link.classList.add('active');
  var navLinks = document.getElementById('nav-links');
  if (navLinks) navLinks.classList.remove('open');
  window.scrollTo(0, 0);
}

function toggleMenu() {
  var navLinks = document.getElementById('nav-links');
  if (navLinks) navLinks.classList.toggle('open');
}

function submitForm() {
  var name    = document.getElementById('f-name').value.trim();
  var email   = document.getElementById('f-email').value.trim();
  var message = document.getElementById('f-message').value.trim();
  var sendTo  = document.getElementById('f-to').value;

  if (!name || !email || !message) {
    alert('Please fill in your name, email, and message before sending.');
    return;
  }
  if (!sendTo) {
    alert('Please select who you would like to send your message to.');
    return;
  }

  /* ── FORMSPREE INTEGRATION ─────────────────────────────
     Sign up at formspree.io, create a form, get your form ID.
     Formspree supports multiple email recipients — set up
     two forms (one for Mulloy, one for Board) or use one
     form with routing based on the sendTo value.

     Replace YOUR_FORM_ID below with your actual form ID,
     then uncomment this block and remove showSuccess() call.

  var recipients = {
    mulloy: 'edouglas@mulloyproperties.com',
    board:  'hoa.twinlakes.board@gmail.com',
    both:   'edouglas@mulloyproperties.com, hoa.twinlakes.board@gmail.com'
  };

  fetch('https://formspree.io/f/YOUR_FORM_ID', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:      name,
      email:     email,
      address:   document.getElementById('f-addr').value.trim(),
      recipient: recipients[sendTo] || sendTo,
      subject:   document.getElementById('f-subject').value.trim(),
      message:   message
    })
  })
  .then(function(r) { if (r.ok) { showSuccess(); } else { alert('Something went wrong. Please try again.'); } })
  .catch(function() { alert('Could not send. Please check your connection.'); });
  return;
  ── ──────────────────────────────────────────────────── */

  showSuccess();
}

function showSuccess() {
  var msg = document.getElementById('success-msg');
  if (msg) msg.style.display = 'block';
  ['f-name','f-addr','f-email','f-subject','f-message'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var sel = document.getElementById('f-to');
  if (sel) sel.selectedIndex = 0;
}
