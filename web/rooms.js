const API_BASE = window.location.origin;
document.getElementById("api-base-label").textContent = API_BASE;

let authToken = null;
let currentUser = null;
let selectedRoom = null;

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

function showMessage(id, text) {
    const el = document.getElementById(id);
    el.textContent = text || "";
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

function updateUserInfo() {
    const emailSpan = document.getElementById("user-email");
    const roleSpan = document.getElementById("user-role");
    const logoutBtn = document.getElementById("logout-btn");
    const adminPanel = document.getElementById("admin-panel");

    if (!currentUser) {
        emailSpan.textContent = "";
        roleSpan.textContent = "";
        logoutBtn.classList.add("hidden");
        adminPanel.classList.add("hidden");
    } else {
        emailSpan.textContent = currentUser.email || "";
        roleSpan.textContent = currentUser.role ? `(${currentUser.role})` : "";
        logoutBtn.classList.remove("hidden");
        if (currentUser.role === "admin") {
            adminPanel.classList.remove("hidden");
        } else {
            adminPanel.classList.add("hidden");
        }
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
        email: "" // email не зашит в токен
    };
    updateUserInfo();
}

// ROOMS

async function loadRooms() {
    try {
        const rooms = await apiRequest("/api/rooms");
        const list = document.getElementById("rooms-list");
        list.innerHTML = "";
        rooms.forEach(room => {
            const li = document.createElement("li");
            li.className = "list-item";
            li.dataset.roomId = room.id;

            const left = document.createElement("div");
            const title = document.createElement("div");
            title.textContent = `#${room.id} ${room.name}`;
            const meta = document.createElement("div");
            meta.className = "list-item__meta";
            meta.textContent = `Вместимость=${room.capacity}${room.description ? " • " + room.description : ""}`;
            left.appendChild(title);
            left.appendChild(meta);

            const right = document.createElement("div");
            const badge = document.createElement("span");
            badge.className = "badge " + (room.is_active ? "badge--success" : "badge--muted");
            badge.textContent = room.is_active ? "active" : "inactive";
            right.appendChild(badge);

            li.appendChild(left);
            li.appendChild(right);

            li.addEventListener("click", () => selectRoom(room));
            list.appendChild(li);
        });
        showMessage("rooms-message", rooms.length === 0 ? "Нет комнат" : "");
    } catch (e) {
        showMessage("rooms-message", e.message);
    }
}

function selectRoom(room) {
    selectedRoom = room;

    const detailsCard = document.getElementById("room-details");
    const bookingsCard = document.getElementById("room-bookings");

    detailsCard.classList.remove("hidden");
    bookingsCard.classList.remove("hidden");

    document.getElementById("room-title").textContent = `Комната #${room.id} ${room.name}`;
    document.getElementById("room-meta").textContent =
        `capacity=${room.capacity}${room.description ? " • " + room.description : ""}` +
        (room.is_active ? "" : " • (inactive)");

    // admin form
    const adminForm = document.getElementById("admin-room-form");
    if (currentUser && currentUser.role === "admin") {
        adminForm.classList.remove("hidden");
        document.getElementById("admin-room-name").value = room.name;
        document.getElementById("admin-room-desc").value = room.description || "";
        document.getElementById("admin-room-capacity").value = room.capacity;
        document.getElementById("admin-room-active").checked = room.is_active;
    } else {
        adminForm.classList.add("hidden");
    }

    loadRoomBookings(room.id);
}

async function loadRoomBookings(roomId) {
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
            right.appendChild(badge);

            if (currentUser && currentUser.id === b.user_id && b.status !== "cancelled") {
                const cancelBtn = document.createElement("button");
                cancelBtn.className = "btn btn--ghost";
                cancelBtn.textContent = "Отменить";
                cancelBtn.style.fontSize = "11px";
                cancelBtn.addEventListener("click", () => cancelBooking(b.id, roomId));
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

async function cancelBooking(bookingId, roomId) {
    try {
        await apiRequest(`/api/bookings/${bookingId}`, { method: "DELETE" });
        await loadRoomBookings(roomId);
    } catch (e) {
        showMessage("bookings-message", e.message);
    }
}

// create booking
document.getElementById("create-booking").addEventListener("click", async () => {
    if (!selectedRoom) {
        showMessage("bookings-message", "Сначала выберите комнату");
        return;
    }
    const start = document.getElementById("booking-start").value.trim();
    const end = document.getElementById("booking-end").value.trim();
    if (!start || !end) {
        showMessage("bookings-message", "Нужно заполнить время начала и окончания");
        return;
    }
    try {
        await apiRequest("/api/bookings", {
            method: "POST",
            body: {
                room_id: selectedRoom.id,
                start_time: start,
                end_time: end
            }
        });
        showMessage("bookings-message", "Бронирование создано");
        await loadRoomBookings(selectedRoom.id);
    } catch (e) {
        showMessage("bookings-message", e.message);
    }
});

// admin: create room
document.getElementById("admin-create-room").addEventListener("click", async () => {
    if (!currentUser || currentUser.role !== "admin") {
        alert("Только админ может создавать комнаты");
        return;
    }
    const name = document.getElementById("admin-new-room-name").value.trim();
    const description = document.getElementById("admin-new-room-desc").value.trim();
    const capacity = parseInt(document.getElementById("admin-new-room-capacity").value, 10) || 1;
    if (!name) {
        showMessage("rooms-message", "Имя комнаты обязательно");
        return;
    }
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

// admin: update room
document.getElementById("admin-save-room").addEventListener("click", async () => {
    if (!currentUser || currentUser.role !== "admin" || !selectedRoom) return;
    const name = document.getElementById("admin-room-name").value.trim();
    const description = document.getElementById("admin-room-desc").value.trim();
    const capacity = parseInt(document.getElementById("admin-room-capacity").value, 10) || 1;
    const active = document.getElementById("admin-room-active").checked;

    try {
        await apiRequest(`/api/rooms/${selectedRoom.id}`, {
            method: "PATCH",
            body: {
                name,
                description,
                capacity,
                photo_url: selectedRoom.photo_url || "",
                is_active: active // это поле есть в БД, но handler его пока не использует; логика может быть расширена
            }
        });
        showMessage("rooms-message", "Комната обновлена");
        await loadRooms();
    } catch (e) {
        showMessage("rooms-message", e.message);
    }
});

// admin: delete room
document.getElementById("admin-delete-room").addEventListener("click", async () => {
    if (!currentUser || currentUser.role !== "admin" || !selectedRoom) return;
    if (!confirm("Удалить эту комнату и все её бронирования?")) return;
    try {
        await apiRequest(`/api/rooms/${selectedRoom.id}`, { method: "DELETE" });
        showMessage("rooms-message", "Комната удалена");
        selectedRoom = null;
        document.getElementById("room-details").classList.add("hidden");
        document.getElementById("room-bookings").classList.add("hidden");
        await loadRooms();
    } catch (e) {
        showMessage("rooms-message", e.message);
    }
});

// reload rooms
document.getElementById("reload-rooms").addEventListener("click", loadRooms);

// logout
document.getElementById("logout-btn").addEventListener("click", () => {
    setAuthToken(null);
    window.location.href = "/";
});

// init
(async function init() {
    await initAuth();
    await loadRooms();
})();
