// Конфиг: базовый URL API (по умолчанию тот же домен + порт 8080)
const API_BASE = window.API_BASE || (window.location.origin.replace(/:\d+$/, "") + ":8080");

document.getElementById("api-base-label").textContent = API_BASE;

let authToken = null;
let currentUser = null;

// ===== Utility =====
function setAuthToken(token) {
    authToken = token;
    if (!token) {
        localStorage.removeItem("bookmyroom_token");
    } else {
        localStorage.setItem("bookmyroom_token", token);
    }
}

function getAuthHeaders() {
    if (!authToken) return {};
    return {
        "Authorization": "Bearer " + authToken
    };
}

async function apiRequest(path, options = {}) {
    const url = API_BASE + path;
    const headers = {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
        ...(options.headers || {})
    };
    const resp = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try {
        data = await resp.json();
    } catch (_) {
        // ignore
    }
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

// ===== Auth UI =====
const loginTab = document.querySelector('[data-tab="login"]');
const registerTab = document.querySelector('[data-tab="register"]');
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");

loginTab.addEventListener("click", () => switchTab("login"));
registerTab.addEventListener("click", () => switchTab("register"));

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
        await fetchCurrentUser(); // через /api/bookings/my не узнать роль, поэтому подгружаем косвенно
        showMessage("auth-message", "Успешный вход");
        await Promise.all([loadRooms(), loadMyBookings()]);
    } catch (e) {
        showMessage("auth-message", e.message);
    }
});

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

document.getElementById("logout-btn").addEventListener("click", () => {
    setAuthToken(null);
    currentUser = null;
    updateUserInfo();
    showMessage("auth-message", "Вы вышли из системы");
    showMessage("bookings-message", "");
});

// ===== User info (получение роли) =====
// В прототипе нет отдельного /me, поэтому роль вытягиваем из токена (JWT payload)
function parseJwt(token) {
    try {
        const base64Url = token.split(".")[1];
        const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
        const jsonPayload = decodeURIComponent(
            atob(base64)
                .split("")
                .map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
                .join("")
        );
        return JSON.parse(jsonPayload);
    } catch (_) {
        return null;
    }
}

async function fetchCurrentUser() {
    if (!authToken) {
        currentUser = null;
        updateUserInfo();
        return;
    }
    const payload = parseJwt(authToken);
    if (!payload) {
        currentUser = null;
        setAuthToken(null);
        updateUserInfo();
        return;
    }
    currentUser = {
        id: payload.user_id,
        role: payload.role,
        // email не шлется в токене, оставляем пустым
        email: ""
    };
    updateUserInfo();
}

function updateUserInfo() {
    const emailSpan = document.getElementById("user-email");
    const roleSpan = document.getElementById("user-role");
    const logoutBtn = document.getElementById("logout-btn");
    const adminPanel = document.getElementById("admin-panel");

    if (!currentUser) {
        emailSpan.textContent = "";
        roleSpan.textContent = "";
        logoutBtn.classList.add("hidden");
        adminPanel.style.display = "none";
    } else {
        emailSpan.textContent = currentUser.email || "";
        roleSpan.textContent = currentUser.role ? `(${currentUser.role})` : "";
        logoutBtn.classList.remove("hidden");
        adminPanel.style.display = currentUser.role === "admin" ? "block" : "none";
    }
}

// ===== Rooms =====
async function loadRooms() {
    try {
        const rooms = await apiRequest("/api/rooms");
        const list = document.getElementById("rooms-list");
        list.innerHTML = "";
        rooms.forEach(room => {
            const li = document.createElement("li");
            li.className = "list-item";

            const left = document.createElement("div");
            const title = document.createElement("div");
            title.textContent = `#${room.id} ${room.name}`;
            const meta = document.createElement("div");
            meta.className = "list-item__meta";
            meta.textContent = `capacity=${room.capacity}${room.description ? " • " + room.description : ""}`;
            left.appendChild(title);
            left.appendChild(meta);

            const right = document.createElement("div");
            const badge = document.createElement("span");
            badge.className = "badge " + (room.is_active ? "badge--success" : "badge--muted");
            badge.textContent = room.is_active ? "active" : "inactive";
            right.appendChild(badge);

            li.appendChild(left);
            li.appendChild(right);
            list.appendChild(li);
        });
        showMessage("rooms-message", rooms.length === 0 ? "Нет комнат" : "");
    } catch (e) {
        showMessage("rooms-message", e.message);
    }
}

document.getElementById("reload-rooms").addEventListener("click", loadRooms);

// Admin create room
document.getElementById("admin-create-room").addEventListener("click", async () => {
    const name = document.getElementById("admin-room-name").value.trim();
    const description = document.getElementById("admin-room-desc").value.trim();
    const capacity = parseInt(document.getElementById("admin-room-capacity").value, 10) || 1;
    showMessage("rooms-message", "");
    try {
        await apiRequest("/api/rooms", {
            method: "POST",
            body: { name, description, capacity, photo_url: "" }
        });
        showMessage("rooms-message", "Комната создана");
        await loadRooms();
    } catch (e) {
        showMessage("rooms-message", e.message);
    }
});

// ===== Bookings =====
async function loadMyBookings() {
    if (!authToken) {
        document.getElementById("bookings-list").innerHTML = "";
        showMessage("bookings-message", "Нужно войти, чтобы видеть бронирования");
        return;
    }
    try {
        const bookings = await apiRequest("/api/bookings/my");
        const list = document.getElementById("bookings-list");
        list.innerHTML = "";
        bookings.forEach(b => {
            const li = document.createElement("li");
            li.className = "list-item";

            const left = document.createElement("div");
            const title = document.createElement("div");
            title.textContent = `#${b.id} room=${b.room_id}`;
            const meta = document.createElement("div");
            meta.className = "list-item__meta";
            meta.textContent = `${b.start_time} → ${b.end_time}`;
            left.appendChild(title);
            left.appendChild(meta);

            const right = document.createElement("div");
            right.style.display = "flex";
            right.style.gap = "6px";
            const badge = document.createElement("span");
            let badgeClass = "badge";
            if (b.status === "confirmed") badgeClass += " badge--success";
            else if (b.status === "cancelled") badgeClass += " badge--muted";
            else badgeClass += " badge--danger";
            badge.className = badgeClass;
            badge.textContent = b.status;

            const cancelBtn = document.createElement("button");
            cancelBtn.className = "btn btn--ghost";
            cancelBtn.textContent = "Отменить";
            cancelBtn.style.fontSize = "11px";
            cancelBtn.addEventListener("click", () => cancelBooking(b.id));

            right.appendChild(badge);
            if (b.status !== "cancelled") {
                right.appendChild(cancelBtn);
            }

            li.appendChild(left);
            li.appendChild(right);
            list.appendChild(li);
        });
        showMessage("bookings-message", bookings.length === 0 ? "Нет бронирований" : "");
    } catch (e) {
        showMessage("bookings-message", e.message);
    }
}

async function cancelBooking(id) {
    try {
        await apiRequest(`/api/bookings/${id}`, { method: "DELETE" });
        await loadMyBookings();
    } catch (e) {
        showMessage("bookings-message", e.message);
    }
}

document.getElementById("create-booking").addEventListener("click", async () => {
    if (!authToken) {
        showMessage("bookings-message", "Сначала войдите");
        return;
    }
    const roomId = parseInt(document.getElementById("booking-room-id").value, 10);
    const start = document.getElementById("booking-start").value.trim();
    const end = document.getElementById("booking-end").value.trim();
    if (!roomId || !start || !end) {
        showMessage("bookings-message", "Нужно заполнить все поля");
        return;
    }
    showMessage("bookings-message", "");
    try {
        await apiRequest("/api/bookings", {
            method: "POST",
            body: { room_id: roomId, start_time: start, end_time: end }
        });
        showMessage("bookings-message", "Бронирование создано");
        await loadMyBookings();
    } catch (e) {
        showMessage("bookings-message", e.message);
    }
});

// ===== Init =====
(async function init() {
    const savedToken = localStorage.getItem("bookmyroom_token");
    if (savedToken) {
        setAuthToken(savedToken);
    }
    await fetchCurrentUser();
    await loadRooms();
    if (authToken) {
        await loadMyBookings();
    } else {
        showMessage("bookings-message", "Нужно войти, чтобы видеть бронирования");
    }
})();
