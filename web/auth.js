// API живет на том же origin
const API_BASE = window.location.origin;

document.getElementById("api-base-label").textContent = API_BASE;

let authToken = null;

function setAuthToken(token) {
    authToken = token;
    if (!token) {
        localStorage.removeItem("bookmyroom_token");
    } else {
        localStorage.setItem("bookmyroom_token", token);
    }
}

async function apiRequest(path, options = {}) {
    const url = API_BASE + path;
    const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
    };
    const resp = await fetch(url, {
        method: options.method || "POST",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try {
        data = await resp.json();
    } catch (_) {}
    if (!resp.ok) {
        const msg = data && data.error ? data.error : resp.statusText;
        throw new Error(msg);
    }
    return data;
}

function showMessage(id, text) {
    const el = document.getElementById(id);
    el.textContent = text || "";
}

// табы
const loginTab = document.querySelector('[data-tab="login"]');
const registerTab = document.querySelector('[data-tab="register"]');
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");

function switchTab(tab) {
    if (tab === "login") {
        loginTab.classList.add("tab--active");
        registerTab.classList.remove("tab--active");
        loginForm.classList.add("form--active");
        registerForm.classList.remove("form--active");
    } else {
        loginTab.classList.remove("tab--active");
        registerTab.classList.add("tab--active");
        loginForm.classList.remove("form--active");
        registerForm.classList.add("form--active");
    }
}

loginTab.addEventListener("click", () => switchTab("login"));
registerTab.addEventListener("click", () => switchTab("register"));

// login
document.getElementById("login-submit").addEventListener("click", async () => {
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    showMessage("auth-message", "");
    try {
        const res = await apiRequest("/api/login", {
            method: "POST",
            body: { email, password }
        });
        setAuthToken(res.token);
        showMessage("auth-message", "Успешный вход, перенаправление...");
        window.location.href = "/rooms.html";
    } catch (e) {
        showMessage("auth-message", e.message);
    }
});

// register
document.getElementById("register-submit").addEventListener("click", async () => {
    const email = document.getElementById("register-email").value.trim();
    const password = document.getElementById("register-password").value;
    showMessage("auth-message", "");
    try {
        await apiRequest("/api/register", {
            method: "POST",
            body: { email, password }
        });
        showMessage("auth-message", "Пользователь создан, теперь войдите");
        switchTab("login");
    } catch (e) {
        showMessage("auth-message", e.message);
    }
});

// если токен уже есть – сразу на rooms.html
(function init() {
    const savedToken = localStorage.getItem("bookmyroom_token");
    if (savedToken) {
        window.location.href = "/rooms.html";
    }
})();
