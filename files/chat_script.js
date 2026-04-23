// ============================================
// CHAT WIDGET — Replace existing chat code
// in script.js with this entire block
// ============================================

document.addEventListener("DOMContentLoaded", () => {
  const chatMessages = [];

  const chatBox = document.getElementById("chat-box");
  const chatToggle = document.getElementById("chat-toggle");
  const chatClose = document.getElementById("chat-close");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const messagesContainer = document.getElementById("chat-messages");

  // Open chat
  chatToggle.addEventListener("click", () => {
    chatBox.style.display = "flex";
    chatToggle.style.display = "none";
    chatInput.focus();
  });

  // Close chat
  chatClose.addEventListener("click", () => {
    chatBox.style.display = "none";
    chatToggle.style.display = "flex";
  });

  // Send on button click
  chatSend.addEventListener("click", sendMessage);

  // Send on Enter key
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    // Add user message
    chatMessages.push({ role: "user", content: text });
    appendMessage("you", text);
    chatInput.value = "";
    chatSend.disabled = true;

    // Show typing indicator
    const typingEl = document.createElement("div");
    typingEl.id = "typing-indicator";
    typingEl.className = "chat-bubble assistant";
    typingEl.innerHTML = `
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>`;
    messagesContainer.appendChild(typingEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    try {
      const res = await fetch("/.netlify/functions/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chatMessages }),
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
    const div = document.createElement("div");
    div.className = `chat-bubble ${sender}`;

    if (sender === "assistant" && typeof marked !== "undefined") {
      div.innerHTML = marked.parse(text);
      // Open all links in new tab
      div.querySelectorAll("a").forEach(a => {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      });
    } else {
      div.textContent = text;
    }

    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
});
