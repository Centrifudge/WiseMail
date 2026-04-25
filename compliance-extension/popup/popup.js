// popup.js
document.addEventListener("DOMContentLoaded", async () => {
  const settings = await browser.storage.local.get(["apiKey"]);

  const dot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");

  if (settings.apiKey) {
    dot.classList.remove("inactive");
    statusText.textContent = "Active — API key configured";
  } else {
    dot.classList.add("inactive");
    statusText.textContent = "Setup needed — no API key";
  }

  document.getElementById("scan-btn").addEventListener("click", async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    browser.tabs.sendMessage(tab.id, { type: "TRIGGER_SCAN" });
    window.close();
  });

  document.getElementById("settings-link").addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  });
});
