let selectedFile = "";
let selectedVideo = null;
let currentJob = "";
let pollTimer = null;
let lastEvidenceQuestion = "";
let lastEvidenceDataset = "";
const answerCache = new Map();
const CHAT_STORAGE_PREFIX = "ytb-rag-chat::";
const THEME_STORAGE_KEY = "ytb-rag-theme";

const $ = (id) => document.getElementById(id);

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  const toggle = $("themeToggle");
  if (toggle) {
    toggle.textContent = nextTheme === "light" ? "☾" : "☼";
    toggle.title = nextTheme === "light" ? "Chuyển sang chế độ tối" : "Chuyển sang chế độ sáng";
  }
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  const preferred = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(saved || preferred);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<strong>$1</strong>");
}

function formatAnswer(value) {
  const lines = String(value || "").split(/\r?\n/);
  const parts = [];
  let listItems = [];

  function flushList() {
    if (!listItems.length) return;
    parts.push("<ul>" + listItems.map(item => `<li>${formatInlineMarkdown(item)}</li>`).join("") + "</ul>");
    listItems = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[1]);
      continue;
    }
    flushList();
    if (trimmed) parts.push(`<p>${formatInlineMarkdown(trimmed)}</p>`);
  }
  flushList();
  return parts.join("");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `<div class="bubble">${role === "assistant" ? formatAnswer(content) : escapeHtml(content)}</div>`;
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div.querySelector(".bubble");
}

function chatStorageKey(file = selectedFile) {
  return CHAT_STORAGE_PREFIX + file;
}

function readCurrentMessages() {
  return [...document.querySelectorAll(".message")].map(node => ({
    role: node.classList.contains("user") ? "user" : "assistant",
    content: node.querySelector(".bubble")?.textContent || ""
  })).filter(message => message.content.trim());
}

function saveCurrentChat() {
  if (!selectedFile) return;
  localStorage.setItem(chatStorageKey(), JSON.stringify(readCurrentMessages()));
}

function loadSavedChat() {
  if (!selectedFile) return false;
  try {
    const messages = JSON.parse(localStorage.getItem(chatStorageKey()) || "[]");
    if (!Array.isArray(messages) || !messages.length) return false;
    $("messages").innerHTML = "";
    messages.forEach(message => addMessage(message.role, message.content));
    return true;
  } catch {
    return false;
  }
}

function resetMessages() {
  $("messages").innerHTML = `
    <div class="message assistant">
      <div class="bubble">Video đã sẵn sàng. Bạn có thể hỏi về nội dung, các bước thực hành, hoặc mở phần kiểm chứng để xem timestamp.</div>
    </div>
  `;
}

function restoreMessages() {
  if (!loadSavedChat()) resetMessages();
}

function showError(message) {
  addMessage("assistant", message || "Request failed");
}

function videoMeta(video) {
  return [video.channel || "YouTube", video.duration || "-"]
    .filter(Boolean)
    .join(" · ");
}

function renderHero(video) {
  if (!video) {
    $("videoHero").className = "video-hero";
    $("videoHero").style.backgroundImage = "";
    $("videoHero").innerHTML = `
      <div class="empty-state">
        <h2>Chọn một video hoặc gửi link mới</h2>
        <p>App sẽ crawl transcript, build vector index, lưu thành dataset, rồi mở một khung hỏi đáp có nguồn timestamp.</p>
      </div>
    `;
    return;
  }

  $("videoHero").className = "video-hero" + (video.thumbnail ? " has-thumb" : "");
  $("videoHero").style.backgroundImage = video.thumbnail
    ? `linear-gradient(90deg, rgba(8, 11, 18, .96), rgba(8, 11, 18, .5)), url("${video.thumbnail}")`
    : "";
  $("videoHero").innerHTML = `
    <div class="video-title">
      <h2>${escapeHtml(video.title)}</h2>
      <p>${escapeHtml(videoMeta(video))}</p>
    </div>
  `;
}

function applySelectedVideo(item, options = {}) {
  selectedFile = item.file;
  selectedVideo = item;
  lastEvidenceQuestion = "";
  lastEvidenceDataset = "";
  renderHero(item);
  if (options.resetMessages !== false) restoreMessages();
  $("questionInput").disabled = !item.has_index;
  $("askButton").disabled = !item.has_index;
  $("evidenceList").textContent = item.has_index
    ? "Chưa có kết quả truy xuất."
    : "Dataset đã tạo nhưng chưa có vector index để hỏi đáp.";
}


function renderVideos(items) {
  const root = $("videoList");
  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = `<div class="video-card"><strong>Chưa có video nào</strong><small>Hãy gửi một link YouTube để bắt đầu.</small></div>`;
    return;
  }
  items.forEach(item => {
    const div = document.createElement("div");
    div.className = "video-card" + (item.file === selectedFile ? " active" : "");
    div.innerHTML = `
      <strong>${escapeHtml(item.title)}</strong>
      <small>${escapeHtml(videoMeta(item))}</small>
      <span class="ready-pill">${item.has_index ? "Sẵn sàng hỏi đáp" : "Đang thiếu index"}</span>
    `;
    div.onclick = () => {
      renderVideos(items);
      applySelectedVideo(item);
    };
    root.appendChild(div);
  });
}

async function refreshVideos() {
  const data = await api("/api/datasets");
  if (!selectedFile && data.datasets.length) {
    const firstReady = data.datasets.find(item => item.has_index) || data.datasets[0];
    selectedFile = firstReady.file;
  }
  renderVideos(data.datasets);
  if (selectedFile) {
    const match = data.datasets.find(item => item.file === selectedFile);
    if (match) applySelectedVideo(match);
  }
  return data.datasets;
}

function inferProgress(logText, status) {
  if (status === "completed") return 100;
  if (status === "failed") return 100;
  if (/Building FAISS|Saved FAISS/i.test(logText)) return 92;
  if (/Generating embeddings|Batches/i.test(logText)) return 78;
  if (/Generating RAG|Saved to/i.test(logText)) return 62;
  if (/Fetching transcripts|transcript/i.test(logText)) return 42;
  if (/metadata|Found|Tìm thấy/i.test(logText)) return 25;
  return 12;
}

function pollJob() {
  if (!currentJob) return;
  api("/api/jobs/" + currentJob).then(job => {
    const logText = job.log.length ? job.log.join("\n") : "Đang khởi động pipeline...";
    const progress = inferProgress(logText, job.status);
    $("jobPanel").hidden = false;
    $("jobStage").textContent = job.status === "running" ? "Processing" : job.status;
    $("jobProgressText").textContent = `${progress}%`;
    $("jobProgress").style.width = `${progress}%`;
    $("jobLog").textContent = logText;
    $("jobLogMirror").textContent = logText;
    $("jobLog").scrollTop = $("jobLog").scrollHeight;

    if (job.status !== "running") {
      clearInterval(pollTimer);
      if (job.status === "completed") {
        selectedFile = job.output_file;
        refreshVideos().then(() => {
          $("jobStage").textContent = "Completed";
          $("jobLogMirror").textContent = logText + "\n\nVideo đã sẵn sàng để hỏi đáp.";
        });
        $("jobProgressText").textContent = "100%";
        $("jobProgress").style.width = "100%";
      } else {
        $("jobStage").textContent = "Failed";
        $("jobLogMirror").textContent = logText + "\n\nJob thất bại. Hãy xem log để biết lỗi ở bước nào.";
      }
    }
  }).catch(err => {
    $("jobLog").textContent = err.message;
    $("jobLogMirror").textContent = err.message;
  });
}

$("ingestForm").onsubmit = async (event) => {
  event.preventDefault();
  const videoUrl = $("videoUrl").value.trim();
  if (!videoUrl) return;
  $("jobPanel").hidden = false;
  $("jobStage").textContent = "Queued";
  $("jobProgressText").textContent = "0%";
  $("jobProgress").style.width = "0%";
  $("jobLog").textContent = "Đang tạo phiên xử lý...";
  $("jobLogMirror").textContent = "Đang tạo phiên xử lý...";
  try {
    const job = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        video_url: videoUrl,
        output_name: "",
        delay: 15,
        transcribe_missing: $("transcribeMissing").checked
      })
    });
    currentJob = job.id;
    clearInterval(pollTimer);
    pollTimer = setInterval(pollJob, 1500);
    pollJob();
  } catch (err) {
    $("jobStage").textContent = "Failed";
    $("jobProgressText").textContent = "0%";
    $("jobLog").textContent = err.message;
    $("jobLogMirror").textContent = err.message;
    showError(err.message);
  }
};


async function updateEvidence() {
  if (!selectedFile) return;
  const question = $("questionInput").value.trim()
    || [...document.querySelectorAll(".message.user .bubble")].at(-1)?.textContent?.trim()
    || "";
  if (!question) return;
  if (question === lastEvidenceQuestion && selectedFile === lastEvidenceDataset) return;

  $("evidenceList").textContent = "Đang tìm đoạn liên quan...";
  const data = await api("/api/ask", {
    method: "POST",
    body: JSON.stringify({ output_file: selectedFile, question, use_llm: false })
  });
  lastEvidenceQuestion = question;
  lastEvidenceDataset = selectedFile;
  if (!data.sources || !data.sources.length) {
    $("evidenceList").textContent = "Chưa tìm thấy đoạn liên quan.";
    return;
  }
  $("evidenceList").innerHTML = data.sources.map(src => `
    <div class="source-card">
      <strong>Chunk #${escapeHtml(src.rank)} · ${escapeHtml(src.time || "")}</strong>
      <div class="source-metrics">
        <span>Similarity: ${formatScore(src.score)}</span>
        <span>Rerank: ${formatScore(src.rerank_score)}</span>
      </div>
      <p>${escapeHtml(src.text || "")}</p>
      <a href="${escapeHtml(src.url || "")}" target="_blank">Mở timestamp</a>
    </div>
  `).join("");
}

function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(4);
}

$("evidenceButton").onclick = updateEvidence;
$("evidencePanel").addEventListener("toggle", () => {
  if ($("evidencePanel").open) updateEvidence();
});
$("refreshVideos").onclick = refreshVideos;
if ($("themeToggle")) {
  $("themeToggle").onclick = () => {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  };
}

$("askForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!selectedFile) return;
  const question = $("questionInput").value.trim();
  if (!question) return;
  addMessage("user", question);
  $("questionInput").value = "";
  const cacheKey = `${selectedFile}::${question.toLowerCase()}`;
  if (answerCache.has(cacheKey)) {
    addMessage("assistant", answerCache.get(cacheKey));
    saveCurrentChat();
    return;
  }
  const bubble = addMessage("assistant", "Đang trả lời...");
  saveCurrentChat();
  try {
    const data = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({ output_file: selectedFile, question, use_llm: true })
    });
    const answer = data.answer || "Không có kết quả.";
    answerCache.set(cacheKey, answer);
    bubble.innerHTML = formatAnswer(answer);
    saveCurrentChat();
  } catch (err) {
    bubble.innerHTML = formatAnswer("Lỗi khi gọi API: " + err.message);
    saveCurrentChat();
  }
};

initTheme();
renderHero(null);
refreshVideos();
