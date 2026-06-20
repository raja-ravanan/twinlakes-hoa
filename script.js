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

// Show/hide the ARC details section based on the selected request type
function onTypeChange() {
  var reqType = document.getElementById('f-type').value;
  var arc = document.getElementById('arc-section');
  var msgLabel = document.getElementById('f-message-label');
  var isArc = (reqType === 'ARC');
  if (arc) arc.style.display = isArc ? 'block' : 'none';
  if (msgLabel) msgLabel.textContent = isArc ? 'Briefly describe the proposed change' : 'Message';
}

// Read selected files into base64 (returns a Promise of an array)
function readArcFiles() {
  var input = document.getElementById('arc-files');
  var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
  return Promise.all(files.map(function(file) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() {
        // strip the "data:...;base64," prefix
        var b64 = String(reader.result).split(',')[1] || '';
        resolve({ filename: file.name, mimeType: file.type || 'application/octet-stream', data: b64 });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }));
}

function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

async function submitForm() {
  var name    = document.getElementById('f-name').value.trim();
  var email   = document.getElementById('f-email').value.trim();
  var message = document.getElementById('f-message').value.trim();
  var sendTo  = document.getElementById('f-to').value;
  var reqType = document.getElementById('f-type').value;

  if (!name || !email || !message) {
    alert('Please fill in your name, email, and message before sending.');
    return;
  }
  if (!reqType) {
    alert('Please select a request type.');
    return;
  }
  if (!sendTo) {
    alert('Please select who you would like to send your message to.');
    return;
  }

  // ── ARC-specific validation & data gathering ──
  var arcDetails = null;
  var files = [];
  if (reqType === 'ARC') {
    var subtype   = val('arc-subtype');
    var materials = val('arc-materials');
    var byEl      = document.querySelector('input[name="arc-by"]:checked');
    var completedBy = byEl ? byEl.value : '';
    var ack       = document.getElementById('arc-ack').checked;
    var signature = val('arc-signature');
    var input     = document.getElementById('arc-files');
    var fileCount = input && input.files ? input.files.length : 0;

    if (!subtype)      { alert('Please select what you are requesting (ARC type).'); return; }
    if (!materials)    { alert('Please describe the construction materials.'); return; }
    if (!completedBy)  { alert('Please indicate who will complete the project.'); return; }
    if (fileCount === 0) { alert('Please attach at least your plot plan (required for ARC requests).'); return; }
    if (!ack)          { alert('Please check the acknowledgment box to agree to the community guidelines.'); return; }
    if (!signature)    { alert('Please type your full name as your electronic signature.'); return; }

    // Size guard (~4.5 MB total)
    var total = 0;
    for (var i = 0; i < input.files.length; i++) total += input.files[i].size;
    if (total > 4.5 * 1024 * 1024) {
      alert('Your attachments total more than 4.5 MB. Please reduce the file sizes (or email large files to the board) and try again.');
      return;
    }

    arcDetails = {
      subtype: subtype,
      phone: val('arc-phone'),
      phoneType: val('arc-phone-type'),
      materials: materials,
      completedBy: completedBy,
      startDate: val('arc-start'),
      endDate: val('arc-end'),
      duration: val('arc-duration'),
      permits: val('arc-permits'),
      landscapeDrawings: val('arc-landscape'),
      irrigationAck: val('arc-irrigation'),
      readRules: val('arc-rules'),
      arrearsAck: val('arc-arrears'),
      attaching: {
        plotPlan: document.getElementById('arc-att-plot').checked,
        plans: document.getElementById('arc-att-plans').checked,
        similar: document.getElementById('arc-att-similar').checked
      },
      acknowledged: ack,
      signature: signature,
      signedDate: new Date().toISOString().slice(0, 10)
    };
  }

  // Disable the button while sending so it can't be double-submitted
  var btn = document.querySelector('.form-submit');
  var originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = reqType === 'ARC' ? 'Uploading…' : 'Sending…'; }

  try {
    if (reqType === 'ARC') files = await readArcFiles();

    var resp = await fetch('/.netlify/functions/submit-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:        name,
        email:       email,
        address:     document.getElementById('f-addr').value.trim(),
        requestType: reqType,
        subject:     document.getElementById('f-subject').value.trim(),
        message:     message,
        sendTo:      sendTo,
        arcDetails:  arcDetails,
        files:       files
      })
    });
    var body = await resp.json();
    if (resp.ok && body.success) {
      showSuccess(body.id);
    } else {
      alert((body && body.error) || 'Something went wrong. Please try again, or email hoa.twinlakes.board@gmail.com directly.');
    }
  } catch (e) {
    alert('Could not send. Please check your connection, or email hoa.twinlakes.board@gmail.com directly.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

function showSuccess(refId) {
  var msg = document.getElementById('success-msg');
  if (msg) {
    if (refId) {
      msg.innerHTML = '<strong>Request received!</strong> Your reference number is <strong>' + refId +
        '</strong>. We’ve emailed you a confirmation and will be in touch within 2–3 business days.';
    }
    msg.style.display = 'block';
  }
  ['f-name','f-addr','f-email','f-subject','f-message'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var typeSel = document.getElementById('f-type');
  if (typeSel) typeSel.selectedIndex = 0;
  var sel = document.getElementById('f-to');
  if (sel) sel.selectedIndex = 0;

  // Reset ARC fields and hide the section
  ['arc-subtype','arc-phone','arc-materials','arc-start','arc-end','arc-duration',
   'arc-permits','arc-landscape','arc-irrigation','arc-rules','arc-arrears',
   'arc-signature','arc-files'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  ['arc-att-plot','arc-att-plans','arc-att-similar','arc-ack'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.checked = false;
  });
  var byChecked = document.querySelector('input[name="arc-by"]:checked');
  if (byChecked) byChecked.checked = false;
  var arc = document.getElementById('arc-section'); if (arc) arc.style.display = 'none';
}

/* ═══════════════════════════════════════════════════════
   COMMUNITY ANNOUNCEMENTS (posted from the Board Portal)
   ═══════════════════════════════════════════════════════ */

function escapeHtmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatAnnouncementDate(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

async function loadAnnouncements() {
  var container = document.getElementById('dynamic-announcements');
  if (!container) return;
  try {
    var res = await fetch('/.netlify/functions/board-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getPublicAnnouncements' })
    });
    var data = await res.json();
    var list = (data && data.announcements) || [];
    if (!list.length) { container.innerHTML = ''; return; }
    container.innerHTML = list.map(function(a) {
      var bodyHtml = escapeHtmlText(a.body).replace(/\n/g, '<br>');
      var dateStr = formatAnnouncementDate(a.date_posted);
      return '<div class="notice-card notice-gold" style="grid-column:1/-1;">' +
        '<div class="notice-badge">Announcement' + (dateStr ? ' &middot; ' + dateStr : '') + '</div>' +
        '<h3>' + escapeHtmlText(a.title) + '</h3>' +
        '<p>' + bodyHtml + '</p>' +
      '</div>';
    }).join('');
  } catch (e) {
    container.innerHTML = '';
  }
}

document.addEventListener('DOMContentLoaded', loadAnnouncements);

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