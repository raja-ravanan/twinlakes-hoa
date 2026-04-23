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
  ───────────────────────────────────────────────────────── */

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

/* ═══════════════════════════════════════════════════════
   CHAT WIDGET
   ═══════════════════════════════════════════════════════ */

document.addEventListener("DOMContentLoaded", () => {
  const chatMessages = [];

  const chatBox        = document.getElementById("chat-box");
  const chatToggle     = document.getElementById("chat-toggle");
  const chatClose      = document.getElementById("chat-close");
  const chatInput      = document.getElementById("chat-input");
  const chatSend       = document.getElementById("chat-send");
  const msgContainer   = document.getElementById("chat-messages");

  // Ensure chat is hidden on load
  chatBox.style.display    = "none";
  chatToggle.style.display = "flex";

  // Open chat
  chatToggle.addEventListener("click", () => {
    chatBox.style.display    = "flex";
    chatToggle.style.display = "none";
    chatInput.focus();
  });

  // Close chat
  chatClose.addEventListener("click", () => {
    chatBox.style.display    = "none";
    chatToggle.style.display = "flex";
  });

  // Send on button click or Enter key
  chatSend.addEventListener("click", sendMessage);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    chatMessages.push({ role: "user", content: text });
    appendMessage("you", text);
    chatInput.value = "";
    chatSend.disabled = true;

    // Show typing indicator
    const typingEl = document.createElement("div");
    typingEl.id        = "typing-indicator";
    typingEl.className = "chat-bubble assistant";
    typingEl.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
    msgContainer.appendChild(typingEl);
    msgContainer.scrollTop = msgContainer.scrollHeight;

    try {
      const res  = await fetch("/.netlify/functions/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages: chatMessages }),
      });
      const data = await res.json();
      document.getElementById("typing-indicator")?.remove();

      if (data.reply) {
        chatMessages.push({ role: "assistant", content: data.reply });
        appendMessage("assistant", data.reply);
      } else {
        appendMessage("assistant", "Sorry, something went wrong. Please try again or contact Eddie Douglas at edouglas@mulloyproperties.com.");
      }
    } catch (err) {
      document.getElementById("typing-indicator")?.remove();
      appendMessage("assistant", "Unable to connect. Please try again or email edouglas@mulloyproperties.com.");
    }

    chatSend.disabled = false;
    chatInput.focus();
  }

  function appendMessage(sender, text) {
    const div       = document.createElement("div");
    div.className   = `chat-bubble ${sender}`;

    if (sender === "assistant" && typeof marked !== "undefined") {
      div.innerHTML = marked.parse(text);
      div.querySelectorAll("a").forEach(a => {
        a.target = "_blank";
        a.rel    = "noopener noreferrer";
      });
    } else {
      div.textContent = text;
    }

    msgContainer.appendChild(div);
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }
});