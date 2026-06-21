document.addEventListener("DOMContentLoaded", async () => {
  const qrEl = document.getElementById("qrcode");
  const logContainer = document.getElementById("log-container");
  const loginSection = document.getElementById("login-section");
  const successMessage = document.getElementById("success-message");
  const successTitle = document.getElementById("success-title");
  const successDesc = document.getElementById("success-desc");
  const refreshBtn = document.getElementById("refresh-btn");
  const verifyCodeSection = document.getElementById("verify-code-section");
  const verifyCodeInput = document.getElementById("verify-code-input");
  const verifyCodeSubmit = document.getElementById("verify-code-submit");
  const qrCard = document.getElementById("qr-card");
  const scanLine = document.getElementById("scan-line");
  const scanedOverlay = document.getElementById("scaned-overlay");
  const redirectSpinner = document.getElementById("redirect-spinner");
  const statusBadge = document.getElementById("status-badge");

  let qrcode = "";
  let polling = false;
  let dotInterval = null;
  let countdownInterval = null;
  let currentLogSpan = null;
  let lastMessage = "";
  let verifyCodeSubmitted = false;

  const expiredCountdownEl = document.getElementById("expired-countdown");

  // Agent endpoints via routeAgentRequest
  // 使用相对路径以适应反向代理路径前缀（如 https://example.com/<prefix>/wechat/qr）
  const QR_FETCH_URL = "../agents/wechat-qr-code-agent/default/qr/fetch";
  const QR_STATUS_URL = "../agents/wechat-qr-code-agent/default/qr/status";
  const QR_VERIFY_CODE_URL = "../agents/wechat-qr-code-agent/default/qr/verify-code";

  function startDotAnimation(textSpan, baseText) {
    if (!textSpan) return;
    let count = 0;
    dotInterval = setInterval(() => {
      count = (count + 1) % 4;
      textSpan.innerText = baseText + ".".repeat(count);
    }, 500);
  }

  function stopDotAnimation() {
    if (dotInterval) {
      clearInterval(dotInterval);
      dotInterval = null;
    }
    if (currentLogSpan && lastMessage) {
      currentLogSpan.innerText = lastMessage;
    }
  }

  function appendLog(text, isNewest = false, isError = false, isSuccess = false) {
    if (!logContainer) return { p: null, textSpan: null };

    const oldHighlights = logContainer.querySelectorAll(".text-white");
    oldHighlights.forEach((el) => {
      el.classList.remove("text-white", "font-bold");
      el.classList.add("text-[#bbcbba]", "opacity-60");
    });

    const p = document.createElement("p");
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });

    let colorClass = "text-[#bbcbba] opacity-60";
    if (isNewest) colorClass = "text-white font-bold transition-all duration-500 ease-in-out";
    if (isError) colorClass = "text-red-400 font-bold";
    if (isSuccess) colorClass = "text-[#45e17c] font-bold drop-shadow-[0_0_8px_rgba(69,225,124,0.5)]";

    p.className = `leading-relaxed break-words ${colorClass}`;
    p.innerHTML = `<span class="text-gray-500 mr-2 text-[11px] font-normal">[${time}]</span><span class="log-text">${text}</span>`;
    logContainer.appendChild(p);

    setTimeout(() => {
      logContainer.scrollTop = logContainer.scrollHeight;
    }, 10);

    return { p, textSpan: p.querySelector(".log-text") };
  }

  function getStatusLabel(status) {
    const labels = {
      wait: "等待扫码",
      scaned: "已扫码，请在手机上确认",
      confirmed: "登录成功",
      expired: "二维码已过期",
      need_verifycode: "需要输入配对码",
      verify_code_blocked: "配对码输入错误次数过多",
      scaned_but_redirect: "正在切换服务器...",
      binded_redirect: "账号已连接"
    };
    return labels[status] || status;
  }

  function startCountdown(seconds) {
    if (!expiredCountdownEl) return;
    stopCountdown();
    let remaining = seconds;
    expiredCountdownEl.classList.remove("hidden");
    expiredCountdownEl.textContent = `将在 ${remaining} 秒后自动刷新`;
    countdownInterval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        stopCountdown();
        refreshBtn.click();
        return;
      }
      expiredCountdownEl.textContent = `将在 ${remaining} 秒后自动刷新`;
    }, 1000);
  }

  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    if (expiredCountdownEl) {
      expiredCountdownEl.classList.add("hidden");
      expiredCountdownEl.textContent = "";
    }
  }

  function updateStatusUI(status) {
    if (!statusBadge || !qrCard) return;

    qrCard.classList.remove("qr-card-scaned", "scaned-glow");
    scanLine?.classList.remove("scaned");
    scanedOverlay?.classList.remove("opacity-100");
    scanedOverlay?.classList.add("opacity-0", "pointer-events-none");
    redirectSpinner?.classList.remove("opacity-100");
    redirectSpinner?.classList.add("opacity-0", "pointer-events-none");

    statusBadge.textContent = getStatusLabel(status);
    statusBadge.className =
      "inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border transition-all duration-500";

    switch (status) {
      case "wait":
        statusBadge.classList.add("status-badge-wait");
        break;
      case "scaned":
        statusBadge.classList.add("status-badge-scaned");
        qrCard.classList.add("scaned-glow");
        scanLine?.classList.add("scaned");
        scanedOverlay?.classList.remove("opacity-0", "pointer-events-none");
        scanedOverlay?.classList.add("opacity-100");
        break;
      case "expired":
        statusBadge.classList.add("status-badge-expired");
        break;
      case "confirmed":
      case "binded_redirect":
        statusBadge.classList.add("status-badge-success");
        break;
      case "scaned_but_redirect":
        statusBadge.classList.add("status-badge-redirect");
        redirectSpinner?.classList.remove("opacity-0", "pointer-events-none");
        redirectSpinner?.classList.add("opacity-100");
        break;
      case "need_verifycode":
      case "verify_code_blocked":
        statusBadge.classList.add("status-badge-verify");
        break;
      default:
        statusBadge.classList.add("status-badge-wait");
    }
  }

  async function fetchQRCode() {
    try {
      appendLog("正在申请二维码资源...");
      const resp = await fetch(QR_FETCH_URL, { method: "POST" });
      if (!resp.ok) throw new Error("获取二维码失败");
      const data = await resp.json();
      qrcode = data.qrcode;

      // Render QR code — qrcodeImg 是 iLink API 返回的二维码短链 URL
      const qrCode = new QRCodeStyling({
        width: 1000,
        height: 1000,
        type: "svg",
        data: data.qrcodeImg,
        dotsOptions: { color: "#131313", type: "rounded" },
        backgroundOptions: { color: "#ffffff" },
        cornersSquareOptions: { type: "extra-rounded", color: "#07c160" },
        cornersDotOptions: { type: "dot", color: "#003917" },
        imageOptions: { crossOrigin: "anonymous", margin: 5 }
      });

      qrCode.append(qrEl);
      const svg = qrEl.querySelector("svg");
      if (svg) {
        svg.style.width = "100%";
        svg.style.height = "100%";
      }

      appendLog("二维码已加载，请使用微信扫码");
      return true;
    } catch (e) {
      appendLog("获取二维码失败: " + e.message, false, true);
      return false;
    }
  }

  async function pollStatus() {
    if (!qrcode || polling) return;
    polling = true;

    try {
      const resp = await fetch(`${QR_STATUS_URL}?qrcode=${encodeURIComponent(qrcode)}`);
      if (!resp.ok) throw new Error("状态查询失败");

      const data = await resp.json();
      const status = data.status;
      const message = getStatusLabel(status);

      if (status === "wait") {
        updateStatusUI("wait");
        if (lastMessage !== message) {
          lastMessage = message;
          stopDotAnimation();
          const { textSpan } = appendLog(message, true);
          currentLogSpan = textSpan;
          startDotAnimation(currentLogSpan, message);
        }
      } else {
        stopDotAnimation();

        // 当状态从 need_verifycode 切换为其他状态时，重置配对码提交标记
        if (lastMessage !== message && status !== "need_verifycode") {
          verifyCodeSubmitted = false;
        }

        if (message !== lastMessage || status === "need_verifycode") {
          lastMessage = message;

          if (status === "confirmed" || status === "binded_redirect") {
            updateStatusUI(status);
            appendLog(message, true, false, true);
            if (status === "binded_redirect") {
              successTitle.textContent = "账号已连接";
              successDesc.textContent = "该微信账号已绑定，无需重复登录。";
            }
            setTimeout(() => {
              loginSection.classList.add("hidden");
              successMessage.classList.remove("hidden");
            }, 1000);
            polling = false;
            return;
          } else if (status === "expired") {
            updateStatusUI("expired");
            appendLog(message, true, true);
            appendLog("请点击刷新按钮重新获取二维码");
            refreshBtn.classList.remove("hidden");
            startCountdown(30);
            polling = false;
            return;
          } else if (status === "need_verifycode") {
            updateStatusUI("need_verifycode");
            if (verifyCodeSubmitted) {
              if (data.hasPendingVerifyCode) {
                // 配对码已提交，等待 pollStatus DO 循环处理中
                appendLog("配对码已提交，正在等待验证...", true);
              } else {
                // 配对码已提交但 DB 中已清除（DO 已处理并判定为错误）
                // 重置标记，允许用户重新输入
                verifyCodeSubmitted = false;
                appendLog("配对码错误，请重新输入", false, true);
                verifyCodeSection.classList.remove("hidden");
                polling = false;
                return;
              }
            } else {
              appendLog(message, true);
              verifyCodeSection.classList.remove("hidden");
              polling = false;
              return;
            }
          } else if (status === "verify_code_blocked") {
            verifyCodeSubmitted = false;
            updateStatusUI("verify_code_blocked");
            appendLog(message, true, true);
            appendLog("请点击刷新按钮重新获取二维码");
            refreshBtn.classList.remove("hidden");
            startCountdown(30);
            polling = false;
            return;
          } else {
            // scaned, scaned_but_redirect etc.
            updateStatusUI(status);
            appendLog(message, true);
          }
        }
      }

      polling = false;
      setTimeout(pollStatus, 2000);
    } catch (e) {
      polling = false;
      stopDotAnimation();
      appendLog("网络波动或网关超时，正在尝试重连...", false, true);
      setTimeout(pollStatus, 2000);
    }
  }

  // Verify code submission
  verifyCodeSubmit.addEventListener("click", async () => {
    const code = verifyCodeInput.value.trim();
    if (!code || code.length !== 8) {
      appendLog("请输入完整的 8 位配对码", false, true);
      return;
    }

    try {
      appendLog("正在提交配对码...");
      const resp = await fetch(QR_VERIFY_CODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qrcode, code })
      });
      if (!resp.ok) throw new Error("提交失败");

      verifyCodeSection.classList.add("hidden");
      verifyCodeInput.value = "";
      verifyCodeSubmitted = true;
      appendLog("配对码已提交，正在等待验证...");

      // Resume polling — 前端看到 need_verifycode 时根据 verifyCodeSubmitted
      // 和 hasPendingVerifyCode 区分"等待验证"和"验证失败"
      polling = false;
      pollStatus();
    } catch (e) {
      appendLog("提交配对码失败: " + e.message, false, true);
    }
  });

  // Refresh button
  refreshBtn.addEventListener("click", () => {
    stopCountdown();
    refreshBtn.classList.add("hidden");
    verifyCodeSection.classList.add("hidden");
    loginSection.classList.remove("hidden");
    successMessage.classList.add("hidden");
    qrcode = "";
    polling = false;
    lastMessage = "";
    verifyCodeSubmitted = false;
    qrEl.innerHTML = "";
    logContainer.innerHTML = "";
    init();
  });

  async function init() {
    updateStatusUI("wait");
    const ok = await fetchQRCode();
    if (ok) {
      pollStatus();
    }
  }

  init();
});
