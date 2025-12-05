const API_BASE = window.location.origin;
document.getElementById("api-base-label").textContent = API_BASE;

let authToken = null;
let currentUser = null;
let roomId = null;
let room = null;

const PLACEHOLDER_PHOTO = "https://via.placeholder.com/800x400?text=Room";

// ==== утилиты ====

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
    return { "Authorization": "Bearer " + authToken };
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
    } catch (_) {}
    if (!resp.ok) {
        const msg = data && data.error ? data.error : resp.statusText;
        throw new Error(msg);
    }
    return data;
}

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

function localInputToRFC3339(str) {
    if (!str) return "";
    const dt = new Date(str);
    return dt.toISOString();
}

function formatLocalDateTime(apiStr) {
    if (!apiStr) return "";
    const dt = new Date(apiStr);
    return dt.toLocaleString("ru-RU", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function showMessage(id, text) {
    const el = document.getElementById(id);
    el.textContent = text || "";
}

// ==== auth + user ====

function updateUserInfo() {
    const emailSpan = document.getElementById("user-email");
    const roleSpan = document.getElementById("user-role");
    const logoutBtn = document.getElementById("logout-btn");

    if (!currentUser) {
        emailSpan.textContent = "";
        roleSpan.textContent = "";
        logoutBtn.classList.add("hidden");
    } else {
        emailSpan.textContent = currentUser.email || "";
        roleSpan.textContent = currentUser.role ? `(${currentUser.role})` : "";
        logoutBtn.classList.remove("hidden");
    }
}

async function initAuth() {
    const savedToken = localStorage.getItem("bookmyroom_token");
    if (!savedToken) {
        window.location.href = "/";
        return;
    }
    setAuthToken(savedToken);
    const payload = parseJwt(authToken);
    if (!payload) {
        setAuthToken(null);
        window.location.href = "/";
        return;
    }
    currentUser = {
        id: payload.user_id,
        role: payload.role,
        email: ""
    };
    updateUserInfo();
}

document.getElementById("logout-btn").addEventListener("click", () => {
    setAuthToken(null);
    window.location.href = "/";
});

// ==== room ====

function getRoomIdFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) return null;
    const num = parseInt(id, 10);
    return Number.isNaN(num) ? null : num;
}

async function loadRoom() {
    try {
        room = await apiRequest(`/api/rooms/${roomId}`);
        const title = document.getElementById("room-title");
        const meta = document.getElementById("room-meta");
        const status = document.getElementById("room-status");
        const img = document.getElementById("room-photo");

        title.textContent = `Комната #${room.id} ${room.name}`;
        meta.textContent = `${room.description || "Без описания"} • capacity=${room.capacity}`;
        status.innerHTML = room.is_active
            ? '<span class="badge badge--success">active</span>'
            : '<span class="badge badge--muted">inactive</span>';

        img.src = room.photo_url && room.photo_url.trim() !== "" ? room.photo_url : PLACEHOLDER_PHOTO;

        // admin form
        const adminForm = document.getElementById("admin-room-form");
        if (currentUser && currentUser.role === "admin") {
            adminForm.classList.remove("hidden");
            document.getElementById("admin-room-name").value = room.name;
            document.getElementById("admin-room-desc").value = room.description || "";
            document.getElementById("admin-room-capacity").value = room.capacity;
            document.getElementById("admin-room-photo").value = room.photo_url || "";
            document.getElementById("admin-room-active").checked = room.is_active;
        } else {
            adminForm.classList.add("hidden");
        }
    } catch (e) {
        alert("Ошибка загрузки комнаты: " + e.message);
    }
}

// ==== bookings ====

async function loadBookings() {
    try {
        const bookings = await apiRequest(`/api/rooms/${roomId}/bookings`);
        const list = document.getElementById("bookings-list");
        list.innerHTML = "";

        bookings.forEach(b => {
            const li = document.createElement("li");
            li.className = "list-item";

            const left = document.createElement("div");
            const title = document.createElement("div");
            title.textContent = `#${b.id} user=${b.user_id}`;
            const meta = document.createElement("div");
            meta.className = "list-item__meta";
            meta.textContent = `${formatLocalDateTime(b.start_time)} → ${formatLocalDateTime(b.end_time)}`;
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
            right.appendChild(badge);

            if (currentUser && currentUser.id === b.user_id && b.status !== "cancelled") {
                const cancelBtn = document.createElement("button");
                cancelBtn.className = "btn btn--ghost";
                cancelBtn.textContent = "Отменить";
                cancelBtn.style.fontSize = "11px";
                cancelBtn.addEventListener("click", () => cancelBooking(b.id));
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
        await loadBookings();
    } catch (e) {
        showMessage("bookings-message", e.message);
    }
}

document.getElementById("create-booking").addEventListener("click", async () => {
    const startLocal = document.getElementById("booking-start-local").value;
    const endLocal = document.getElementById("booking-end-local").value;
    if (!startLocal || !endLocal) {
        showMessage("bookings-message", "Заполните время начала и окончания");
        return;
    }
    const start = localInputToRFC3339(startLocal);
    const end = localInputToRFC3339(endLocal);

    try {
        await apiRequest("/api/bookings", {
            method: "POST",
            body: {
                room_id: roomId,
                start_time: start,
                end_time: end
            }
        });
        showMessage("bookings-message", "Бронирование создано");
        await loadBookings();
    } catch (e) {
        showMessage("bookings-message", e.message);
    }
});

// ==== admin: save room ====

document.getElementById("admin-save-room").addEventListener("click", async () => {
    if (!currentUser || currentUser.role !== "admin") return;
    const name = document.getElementById("admin-room-name").value.trim();
    const description = document.getElementById("admin-room-desc").value.trim();
    const capacity = parseInt(document.getElementById("admin-room-capacity").value, 10) || 1;
    const photo_url = document.getElementById("admin-room-photo").value.trim();
    const is_active = document.getElementById("admin-room-active").checked;

    try {
        await apiRequest(`/api/rooms/${roomId}`, {
            method: "PATCH",
            body: {
                name,
                description,
                capacity,
                photo_url,
                is_active
            }
        });
        await loadRoom();
        showMessage("bookings-message", "Комната обновлена");
    } catch (e) {
        alert("Ошибка сохранения комнаты: " + e.message);
    }
});

// ==== init ====

(async function init() {
    roomId = getRoomIdFromQuery();
    if (!roomId) {
        alert("Не указан id комнаты в URL");
        window.location.href = "/rooms.html";
        return;
    }
    await initAuth();
    await loadRoom();
    await loadBookings();
})();
