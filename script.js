/* ═══════════════════════════════════════════════════════
   TWIN LAKES AT FLOYDS FORK — script.js
   ═══════════════════════════════════════════════════════ */

function go(pageName) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-links a').forEach(function(a) { a.classList.remove('active'); });
  document.querySelectorAll('.nav-group-label').forEach(function(l) { l.classList.remove('active'); });
  document.querySelectorAll('.nav-group').forEach(function(g) { g.classList.remove('open'); });
  var page = document.getElementById('page-' + pageName);
  var link = document.getElementById('nav-' + pageName);
  if (page) page.classList.add('active');
  if (link) {
    link.classList.add('active');
    // If this link lives inside a dropdown, highlight its group label too.
    var group = link.closest ? link.closest('.nav-group') : null;
    if (group) {
      var label = group.querySelector('.nav-group-label');
      if (label) label.classList.add('active');
    }
  }
  var navLinks = document.getElementById('nav-links');
  if (navLinks) navLinks.classList.remove('open');
  window.scrollTo(0, 0);
}

// Announcements page: smooth-scroll to a section from the "On this page" side nav.
function uJump(id) {
  var el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return false;
}

// Homepage feedback form — posts to the same pipeline as resident requests,
// tagged as "Feedback", so it lands in the board's inbox and Resident Requests.
async function submitFeedback() {
  var email = (document.getElementById('fb-email').value || '').trim();
  var message = (document.getElementById('fb-message').value || '').trim();
  var name = (document.getElementById('fb-name').value || '').trim() || 'Resident';
  var status = document.getElementById('fb-status');
  status.style.color = '#c0492e';
  if (!email || !message) { status.textContent = 'Please add your email and a short note.'; return; }
  status.textContent = '';
  var btn = document.getElementById('fb-submit');
  var label = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…';
  try {
    var resp = await fetch('/.netlify/functions/submit-request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, requestType: 'Feedback', subject: 'Website Feedback', message: message, sendTo: 'board' })
    });
    var body = await resp.json();
    if (resp.ok && body.success) {
      document.getElementById('fb-form').style.display = 'none';
      document.getElementById('fb-thanks').style.display = 'block';
    } else {
      status.textContent = (body && body.error) || 'Something went wrong. Please email us directly.';
    }
  } catch (e) {
    status.textContent = 'Could not send. Please check your connection, or email us directly.';
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// In-site document viewer — shows a Drive PDF in a modal so residents stay on
// the site (no exposed Drive folder, no missing back button).
var _docCurrentId = null;
function openDoc(id, title) {
  _docCurrentId = id;
  document.getElementById('doc-modal-title').textContent = title || 'Document';
  document.getElementById('doc-frame').src = 'https://drive.google.com/file/d/' + id + '/preview';
  document.getElementById('doc-dl').href = 'https://drive.google.com/uc?export=download&id=' + id;
  document.getElementById('doc-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  return false;
}
function closeDoc() {
  document.getElementById('doc-modal').classList.remove('open');
  document.getElementById('doc-frame').src = '';
  document.body.style.overflow = '';
  _docCurrentId = null;
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    var m = document.getElementById('doc-modal');
    if (m && m.classList.contains('open')) closeDoc();
  }
});

function toggleMenu() {
  var navLinks = document.getElementById('nav-links');
  if (navLinks) navLinks.classList.toggle('open');
}

// Mobile: expand/collapse a nav dropdown group (desktop uses hover via CSS).
function toggleNavGroup(labelEl) {
  var group = labelEl.closest ? labelEl.closest('.nav-group') : labelEl.parentElement;
  if (group) group.classList.toggle('open');
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

// Safe lightweight formatter for meeting-minute summaries.
// Escapes everything first, then renders a small, known subset:
//   "## Heading"  -> <h4>        "* " / "- " / "• "  -> bullet list
//   "**bold**"    -> <strong>    blank line          -> paragraph break
function formatMinutesSummary(raw) {
  var lines = String(raw == null ? '' : raw).split('\n');
  var html = '', inList = false;
  function closeList() { if (inList) { html += '</ul>'; inList = false; } }
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t) { closeList(); continue; }
    if (/^(\*|-|•)\s+/.test(t)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + escapeHtmlText(t.replace(/^(\*|-|•)\s+/, '')) + '</li>';
    } else if (/^#{1,3}\s+/.test(t)) {
      closeList();
      html += '<h4>' + escapeHtmlText(t.replace(/^#{1,3}\s+/, '')) + '</h4>';
    } else {
      closeList();
      html += '<p>' + escapeHtmlText(t) + '</p>';
    }
  }
  closeList();
  // Bold (**text**) — applied after escaping, so injecting <strong> is safe.
  return html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function formatAnnouncementDate(iso) {
  // Parse plain YYYY-MM-DD as a LOCAL date to avoid UTC off-by-one.
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || '').trim());
  var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Announcement body formatter: escapes everything, then renders Markdown-style
// links [text](target). http(s) targets open in a new tab; anything else is
// treated as an on-site page name and navigates via go() (see the a[data-nav]
// handler below). Newlines become <br>. Same output for the page + the banner.
function formatAnnouncementBody(raw) {
  var s = escapeHtmlText(raw);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
    if (/^https?:\/\//i.test(url)) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    }
    var page = url.replace(/^#/, '').replace(/[^a-z0-9_-]/gi, '');
    return '<a href="#" data-nav="' + page + '">' + text + '</a>';
  });
  return s.replace(/\n/g, '<br>');
}

// One delegated handler for in-body links that point to an on-site page.
document.addEventListener('click', function (e) {
  var a = e.target.closest ? e.target.closest('a[data-nav]') : null;
  if (!a) return;
  e.preventDefault();
  if (typeof go === 'function') go(a.getAttribute('data-nav'));
});

/* ── Announcement organization (Phase 1B): category groups, archive
   handling, and one shared card renderer for the Updates page, the
   homepage discovery sections, and Upcoming Work. ── */

// Real category values (docs/announcement-schema.md) grouped into the
// resident-facing filter chips shown on the Updates page.
var ANN_CATEGORY_GROUPS = {
  'General': 'general', 'Documents': 'general',
  'Ponds': 'pond-landscaping', 'Landscaping': 'pond-landscaping', 'Irrigation': 'pond-landscaping',
  'Board & Meetings': 'board-meetings',
  'Traffic': 'traffic-safety', 'Safety': 'traffic-safety',
  'Community Events': 'community-events',
  'Maintenance': 'maintenance-services'
};
var ANN_FILTER_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'general', label: 'General' },
  { key: 'pond-landscaping', label: 'Pond & Landscaping' },
  { key: 'board-meetings', label: 'Board & Meetings' },
  { key: 'traffic-safety', label: 'Traffic & Safety' },
  { key: 'community-events', label: 'Community Events' },
  { key: 'maintenance-services', label: 'Maintenance & Services' }
];
function categoryGroupKey(cat) { return ANN_CATEGORY_GROUPS[cat] || 'general'; }

var MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var WORK_STATUS_LABELS = { upcoming: 'Upcoming', 'in-progress': 'In Progress', completed: 'Completed' };
var WORK_STATUS_BADGE_CLASS = { upcoming: 'badge-blue', 'in-progress': 'badge-gold', completed: 'badge-green' };
function workStatusBadge(status) {
  if (!status || !WORK_STATUS_LABELS[status]) return '';
  return '<span class="badge ' + WORK_STATUS_BADGE_CLASS[status] + '">' + WORK_STATUS_LABELS[status] + '</span>';
}
function priorityBadge(priority) {
  if (priority === 'critical') return '<span class="badge badge-red">Critical</span>';
  if (priority === 'high') return '<span class="badge badge-gold">High Priority</span>';
  return '';
}

function todayISODate() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Plain YYYY-MM-DD string check — deliberately not `new Date(...)` parsing,
// so comparisons stay a local calendar-date string compare with no UTC shift.
function isValidCalendarDateString(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}
// An announcement archives once its archive_date is BEFORE today (today
// itself still counts as active for the whole day). It then drops out of
// the homepage sections and Latest Updates, but stays visible under Older
// Updates on the Updates page. Blank or invalid archive_date never archives.
function isAnnouncementArchived(a) {
  var d = String(a.archive_date || '').trim();
  if (!isValidCalendarDateString(d)) return false;
  return d < todayISODate();
}

// Plain-text fallback when the board hasn't set a summary: strips the
// markdown-lite link syntax down to its visible text, then truncates on a
// word boundary.
function announcementExcerpt(body, maxLen) {
  maxLen = maxLen || 140;
  var plain = String(body || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (plain.length <= maxLen) return plain;
  return plain.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

// Single source of truth for announcement card markup.
//   'standard' — Updates page (full body, event-date row)
//   'compact'  — Upcoming Work row (event date + title + summary)
//   'homepage' — Latest Updates card (summary instead of full body)
// All user-entered fields are escaped before insertion.
function renderAnnouncementCard(a, variant) {
  var category = escapeHtmlText(a.category || 'General');
  var groupKey = categoryGroupKey(a.category || 'General');
  var dateStr = formatAnnouncementDate(a.date_posted);
  var eventStr = a.event_date ? formatAnnouncementDate(a.event_date) : '';
  var summaryText = escapeHtmlText((a.summary || '').trim() || announcementExcerpt(a.body));
  var badges = priorityBadge(a.priority) + workStatusBadge(a.work_status);
  var badgeRow = badges ? '<div class="ann-badge-row">' + badges + '</div>' : '';
  var eventRow = eventStr
    ? '<div class="notice-detail"><div class="notice-detail-row"><span class="nd-label">Event Date</span><span>' + escapeHtmlText(eventStr) + '</span></div></div>'
    : '';

  if (variant === 'compact') {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a.event_date || '');
    var dateBlock = m
      ? '<div class="upcoming-date"><div class="ud-month">' + MONTH_ABBR[(+m[2]) - 1] + '</div><div class="ud-day">' + (+m[3]) + '</div></div>'
      : '<div class="upcoming-date"><div class="ud-month">Date</div><div class="ud-day">TBD</div></div>';
    return '<div class="upcoming-item">' + dateBlock +
      '<div class="upcoming-body">' +
        '<div class="notice-badge">' + category + '</div>' +
        badgeRow +
        '<h4>' + escapeHtmlText(a.title) + '</h4>' +
        (summaryText ? '<p>' + summaryText + '</p>' : '') +
      '</div>' +
    '</div>';
  }

  if (variant === 'homepage') {
    return '<div class="notice-card notice-gold" data-ann-group="' + groupKey + '">' +
      '<div class="notice-badge">' + category + (dateStr ? ' &middot; ' + escapeHtmlText(dateStr) : '') + '</div>' +
      badgeRow +
      '<h3>' + escapeHtmlText(a.title) + '</h3>' +
      (summaryText ? '<p>' + summaryText + '</p>' : '') +
      eventRow +
    '</div>';
  }

  // 'standard' — Updates page
  var bodyHtml = formatAnnouncementBody(a.body);
  return '<div class="notice-card notice-gold" style="grid-column:1/-1;" data-ann-group="' + groupKey + '">' +
    '<div class="notice-badge">' + category + (dateStr ? ' &middot; ' + escapeHtmlText(dateStr) : '') + '</div>' +
    badgeRow +
    '<h3>' + escapeHtmlText(a.title) + '</h3>' +
    '<p>' + bodyHtml + '</p>' +
    eventRow +
  '</div>';
}

function renderCriticalAlert(a) {
  var summaryText = escapeHtmlText((a.summary || '').trim() || announcementExcerpt(a.body, 180));
  var dateStr = formatAnnouncementDate(a.date_posted);
  var eventStr = a.event_date ? formatAnnouncementDate(a.event_date) : '';
  var metaParts = [];
  if (dateStr) metaParts.push('Posted ' + escapeHtmlText(dateStr));
  if (eventStr) metaParts.push('Event ' + escapeHtmlText(eventStr));
  return '<div class="ca-badge">Critical Alert</div>' +
    '<h3>' + escapeHtmlText(a.title) + '</h3>' +
    (summaryText ? '<p>' + summaryText + '</p>' : '') +
    (metaParts.length ? '<div class="ca-meta">' + metaParts.join(' &middot; ') + '</div>' : '');
}

// Single fetch of getPublicAnnouncements shared by the Updates page and the
// homepage discovery sections (the banner keeps its own separate fetch).
var _annCache = null;
async function fetchPublicAnnouncements() {
  if (_annCache) return _annCache;
  var res = await fetch('/.netlify/functions/board-api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getPublicAnnouncements' })
  });
  var data = await res.json();
  _annCache = (data && data.announcements) || [];
  return _annCache;
}

var _annActiveFilter = 'all';

function buildAnnouncementFilterBar() {
  var bar = document.getElementById('ann-filter-bar');
  if (!bar) return;
  bar.innerHTML = ANN_FILTER_CHIPS.map(function(c) {
    return '<button type="button" class="ann-chip' + (c.key === 'all' ? ' active' : '') + '" data-key="' + c.key + '" ' +
      'aria-pressed="' + (c.key === 'all' ? 'true' : 'false') + '" onclick="applyAnnouncementFilter(\'' + c.key + '\')">' + c.label + '</button>';
  }).join('');
}

// Client-side filter: toggles visibility of already-rendered cards, no
// refetch and no page reload.
function applyAnnouncementFilter(groupKey) {
  _annActiveFilter = groupKey;
  var cards = document.querySelectorAll('#dynamic-announcements [data-ann-group]');
  var visible = 0;
  cards.forEach(function(card) {
    var show = groupKey === 'all' || card.getAttribute('data-ann-group') === groupKey;
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  var empty = document.getElementById('dynamic-announcements-empty');
  if (empty) empty.style.display = visible ? 'none' : '';
  document.querySelectorAll('.ann-chip').forEach(function(chip) {
    var active = chip.getAttribute('data-key') === groupKey;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

async function loadAnnouncements() {
  var container = document.getElementById('dynamic-announcements');
  if (!container) return;
  var olderSection = document.getElementById('older-updates-section');
  var olderContainer = document.getElementById('older-announcements');
  buildAnnouncementFilterBar();
  try {
    var list = await fetchPublicAnnouncements();
    var current = list.filter(function(a) { return !isAnnouncementArchived(a); });
    var older = list.filter(isAnnouncementArchived);

    container.innerHTML = current.length
      ? current.map(function(a) { return renderAnnouncementCard(a, 'standard'); }).join('') +
        '<p id="dynamic-announcements-empty" class="ann-empty" style="display:none;grid-column:1/-1;">No announcements in this category right now.</p>'
      : '';

    if (olderSection && olderContainer) {
      if (older.length) {
        olderContainer.innerHTML = older.map(function(a) { return renderAnnouncementCard(a, 'standard'); }).join('');
        olderSection.style.display = '';
      } else {
        olderContainer.innerHTML = '';
        olderSection.style.display = 'none';
      }
    }
    applyAnnouncementFilter(_annActiveFilter);
  } catch (e) {
    container.innerHTML = '';
  }
}

// Homepage discovery sections: Critical Alert, Upcoming Work, Latest
// Updates. Each hides itself completely when it has nothing to show.
async function loadHomepageDiscovery() {
  var caSection = document.getElementById('critical-alert-section');
  var caBox = document.getElementById('critical-alert');
  var upSection = document.getElementById('upcoming-work-section');
  var upList = document.getElementById('upcoming-work-list');
  var luSection = document.getElementById('latest-updates-section');
  var luGrid = document.getElementById('latest-updates-grid');
  if (!caSection && !upSection && !luSection) return;
  try {
    var list = await fetchPublicAnnouncements();
    var active = list.filter(function(a) { return !isAnnouncementArchived(a); });

    // Critical Alert — most recent published, non-archived, priority=critical.
    var critical = active.filter(function(a) { return a.priority === 'critical'; })[0];
    if (caSection && caBox) {
      if (critical) { caBox.innerHTML = renderCriticalAlert(critical); caSection.style.display = ''; }
      else { caBox.innerHTML = ''; caSection.style.display = 'none'; }
    }

    // Upcoming Work — work_status=upcoming OR a future event_date; soonest
    // first. Completed items are excluded even if they carry a future date.
    var today = todayISODate();
    var upcoming = active.filter(function(a) {
      if (a.work_status === 'completed') return false;
      var hasFutureEvent = isValidCalendarDateString(a.event_date) && a.event_date >= today;
      return a.work_status === 'upcoming' || hasFutureEvent;
    }).sort(function(x, y) {
      var xd = isValidCalendarDateString(x.event_date) ? x.event_date : '9999-99-99';
      var yd = isValidCalendarDateString(y.event_date) ? y.event_date : '9999-99-99';
      return xd < yd ? -1 : xd > yd ? 1 : 0;
    });
    if (upSection && upList) {
      if (upcoming.length) { upList.innerHTML = upcoming.map(function(a) { return renderAnnouncementCard(a, 'compact'); }).join(''); upSection.style.display = ''; }
      else { upList.innerHTML = ''; upSection.style.display = 'none'; }
    }

    // Latest Updates — 5 newest published (API already sorts newest-first).
    var latest = active.slice(0, 5);
    if (luSection && luGrid) {
      if (latest.length) { luGrid.innerHTML = latest.map(function(a) { return renderAnnouncementCard(a, 'homepage'); }).join(''); luSection.style.display = ''; }
      else { luGrid.innerHTML = ''; luSection.style.display = 'none'; }
    }
  } catch (e) {
    if (caSection) caSection.style.display = 'none';
    if (upSection) upSection.style.display = 'none';
    if (luSection) luSection.style.display = 'none';
  }
}

// Expand/collapse a banner announcement. Desktop also opens it on hover (CSS);
// this click/keyboard toggle is what makes it work on touch devices.
function toggleAnnItem(el) {
  var open = el.classList.toggle('open');
  el.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function annItemKey(e, el) {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggleAnnItem(el); }
}

// Top announcements banner — shows the 3 most recent board posts.
// Same data source as the Announcements page, so one portal post updates both.
async function loadBanner() {
  var bar = document.getElementById('announcement-bar');
  var inner = document.getElementById('dynamic-banner');
  if (!bar || !inner) return;
  try {
    var res = await fetch('/.netlify/functions/board-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getPublicAnnouncements' })
    });
    var data = await res.json();
    var list = (data && data.announcements) || [];
    if (!list.length) { bar.style.display = 'none'; return; }
    var top = list.slice(0, 3);
    inner.innerHTML = top.map(function(a) {
      var bodyHtml = formatAnnouncementBody(a.body);
      var dateStr = formatAnnouncementDate(a.date_posted);
      return '<div class="announcement-item" role="button" tabindex="0" aria-expanded="false" onclick="toggleAnnItem(this)" onkeydown="annItemKey(event, this)">' +
        '<div class="ann-dot info"></div>' +
        '<span class="ann-text"><strong>' + escapeHtmlText(a.title) + '</strong></span>' +
        '<span class="ann-chevron">&#9660;</span>' +
        '<div class="ann-dropdown">' +
          '<div class="ann-dropdown-title">' + escapeHtmlText(a.title) + '</div>' +
          '<div class="ann-dropdown-body">' + bodyHtml + '</div>' +
          '<div class="ann-dropdown-footer">HOA Board' + (dateStr ? ' &middot; ' + dateStr : '') + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    bar.style.display = '';
  } catch (e) {
    bar.style.display = 'none';
  }
}

function monthKeyFromDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || '').trim());
  var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
  if (isNaN(d)) return { key: 'unknown', label: 'Other' };
  return {
    key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
    label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  };
}

function toggleMinutesMonth(headerEl) {
  var wrap = headerEl.parentElement;
  if (wrap) wrap.classList.toggle('open');
}

// Renders a newest-first list of minutes as month-grouped accordions.
// opts.open === true auto-expands the most recent month. Empty list -> ''.
function renderMinutesGroups(list, opts) {
  opts = opts || {};
  if (!list.length) return '';
  var groups = [];
  var byKey = {};
  list.forEach(function(m) {
    var mk = monthKeyFromDate(m.meeting_date);
    if (!byKey[mk.key]) { byKey[mk.key] = { key: mk.key, label: mk.label, items: [] }; groups.push(byKey[mk.key]); }
    byKey[mk.key].items.push(m);
  });
  return groups.map(function(g, gi) {
    var openClass = (opts.open && gi === 0) ? ' open' : '';   // most recent month expanded by default
    var entries = g.items.map(function(m) {
      var summaryHtml = formatMinutesSummary(m.summary);
      var dateStr = formatAnnouncementDate(m.meeting_date);
      var attendees = (m.attendees || '').trim();
      var attendeesHtml = attendees
        ? '<p class="mm-attendees"><strong>In attendance:</strong> ' + escapeHtmlText(attendees) + '</p>'
        : '';
      return '<div class="minutes-entry">' +
        (dateStr ? '<div class="mm-date">' + dateStr + '</div>' : '') +
        '<h3>' + escapeHtmlText(m.title) + '</h3>' +
        attendeesHtml +
        '<div class="mm-summary">' + summaryHtml + '</div>' +
      '</div>';
    }).join('');
    var count = g.items.length + ' ' + (g.items.length === 1 ? 'meeting' : 'meetings');
    return '<div class="minutes-month' + openClass + '">' +
      '<button class="minutes-month-header" onclick="toggleMinutesMonth(this)">' +
        '<span class="mm-label">' + escapeHtmlText(g.label) + '</span>' +
        '<span class="mm-meta">' + count + ' <span class="mm-chev">&#9660;</span></span>' +
      '</button>' +
      '<div class="minutes-month-body">' + entries + '</div>' +
    '</div>';
  }).join('');
}

async function loadMinutes() {
  var boardEl = document.getElementById('board-minutes');
  var communityEl = document.getElementById('community-minutes');
  if (!boardEl && !communityEl) return;
  try {
    var res = await fetch('/.netlify/functions/board-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getPublicMinutes' })
    });
    var data = await res.json();
    var list = (data && data.minutes) || [];   // newest-first from the API
    // Route each posted minute into its section; anything not tagged is a board meeting.
    var community = list.filter(function(m) { return m.meeting_type === 'community'; });
    var board = list.filter(function(m) { return m.meeting_type !== 'community'; });

    // Community meetings render below the hardcoded annual/special entries (none auto-open).
    if (communityEl) communityEl.innerHTML = renderMinutesGroups(community, { open: false });

    if (boardEl) {
      boardEl.innerHTML = board.length
        ? renderMinutesGroups(board, { open: true })
        : '<p style="text-align:center;font-family:sans-serif;color:var(--text-m);">No board meeting minutes have been posted yet. Please check back soon.</p>';
    }
  } catch (e) {
    if (boardEl) boardEl.innerHTML = '<p style="text-align:center;font-family:sans-serif;color:var(--text-m);">Meeting minutes are temporarily unavailable. Please try again later.</p>';
  }
}

// Financials page is gated by a board-controlled publish flag. Default = hidden
// (Coming Soon) until the board turns it on from the portal.
async function loadFinancialsFlag() {
  var comingSoon = document.getElementById('fin-comingsoon');
  var content = document.getElementById('fin-content');
  if (!comingSoon || !content) return;
  try {
    var res = await fetch('/.netlify/functions/board-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getPublicSettings' })
    });
    var data = await res.json();
    if (data && data.financials_published) {
      comingSoon.style.display = 'none';
      content.style.display = 'block';
    }
  } catch (e) { /* keep Coming Soon on error */ }
}

document.addEventListener('DOMContentLoaded', loadBanner);
document.addEventListener('DOMContentLoaded', loadAnnouncements);
document.addEventListener('DOMContentLoaded', loadHomepageDiscovery);
document.addEventListener('DOMContentLoaded', loadMinutes);
document.addEventListener('DOMContentLoaded', loadFinancialsFlag);

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