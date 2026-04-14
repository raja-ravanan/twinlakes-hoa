/* ═══════════════════════════════════════════════════════════
   TWIN LAKES HOA — script.js
   ═══════════════════════════════════════════════════════════ */

/**
 * Switch between pages.
 * Called from nav links and buttons throughout the site.
 */
function go(pageName) {
  document.querySelectorAll('.page').forEach(function(page) {
    page.classList.remove('active');
  });
  document.querySelectorAll('.nav-links a').forEach(function(link) {
    link.classList.remove('active');
  });

  var targetPage = document.getElementById('page-' + pageName);
  var targetNav  = document.getElementById('nav-' + pageName);

  if (targetPage) targetPage.classList.add('active');
  if (targetNav)  targetNav.classList.add('active');

  window.scrollTo(0, 0);
}

/**
 * Handle contact form submission.
 * Currently shows a success message.
 * When you connect Formspree, this function will POST to their endpoint.
 */
function submitForm() {
  var name    = document.getElementById('f-name').value.trim();
  var email   = document.getElementById('f-email').value.trim();
  var message = document.getElementById('f-message').value.trim();

  if (!name || !email || !message) {
    alert('Please fill in your name, email, and message before sending.');
    return;
  }

  /* ── FORMSPREE INTEGRATION (add later) ──────────────────────
     When you sign up at formspree.io and get your form ID,
     replace the success block below with a fetch() call:

     fetch('https://formspree.io/f/YOUR_FORM_ID', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         name:    name,
         email:   email,
         address: document.getElementById('f-addr').value,
         sendTo:  document.getElementById('f-to').value,
         subject: document.getElementById('f-subject').value,
         message: message
       })
     })
     .then(function(response) {
       if (response.ok) { showSuccess(); }
       else { alert('Something went wrong. Please try again.'); }
     })
     .catch(function() {
       alert('Could not send message. Please check your connection.');
     });

     And remove the showSuccess() call directly below.
  ── ─────────────────────────────────────────────────────── */

  showSuccess();
}

function showSuccess() {
  var successMsg = document.getElementById('success-msg');
  if (successMsg) successMsg.style.display = 'block';

  document.getElementById('f-name').value    = '';
  document.getElementById('f-addr').value    = '';
  document.getElementById('f-email').value   = '';
  document.getElementById('f-subject').value = '';
  document.getElementById('f-message').value = '';
  document.getElementById('f-to').selectedIndex = 0;
}
