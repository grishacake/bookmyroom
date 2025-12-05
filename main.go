package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	_ "github.com/lib/pq"
)

type User struct {
	ID        int64     `json:"id"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

type Room struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Capacity    int       `json:"capacity"`
	PhotoURL    string    `json:"photo_url,omitempty"`
	IsActive    bool      `json:"is_active"`
	CreatedAt   time.Time `json:"created_at"`
}

type Booking struct {
	ID        int64     `json:"id"`
	RoomID    int64     `json:"room_id"`
	UserID    int64     `json:"user_id"`
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

// запросы/ответы

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token string `json:"token"`
}

type createRoomRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Capacity    int    `json:"capacity"`
	PhotoURL    string `json:"photo_url"`
}

type createBookingRequest struct {
	RoomID    int64  `json:"room_id"`
	StartTime string `json:"start_time"` // RFC3339
	EndTime   string `json:"end_time"`   // RFC3339
}

type updateBookingRequest struct {
	Status string `json:"status"`
}

// Auth в контексте

type ctxKey string

const userCtxKey ctxKey = "user"

type AuthUser struct {
	ID   int64
	Role string
}

// JWT

type Claims struct {
	UserID int64  `json:"user_id"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

// глобальный state прототипа

type App struct {
	DB        *sql.DB
	JWTSecret []byte
}

func main() {
	dsn := os.Getenv("DB_DSN")
	if dsn == "" {
		log.Fatal("DB_DSN is not set")
	}
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		log.Fatal("JWT_SECRET is not set")
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("ping db: %v", err)
	}

	app := &App{
		DB:        db,
		JWTSecret: []byte(jwtSecret),
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Публичные эндпоинты
	r.Post("/api/register", app.handleRegister)
	r.Post("/api/login", app.handleLogin)

	// Публичный просмотр комнат и расписаний
	r.Get("/api/rooms", app.handleListRooms)
	r.Get("/api/rooms/{roomID}", app.handleGetRoom)
	r.Get("/api/rooms/{roomID}/bookings", app.handleRoomBookings)

	// Защищенные маршруты
	r.Group(func(pr chi.Router) {
		pr.Use(app.authMiddleware)

		pr.Get("/api/bookings/my", app.handleMyBookings)
		pr.Post("/api/bookings", app.handleCreateBooking)
		pr.Patch("/api/bookings/{bookingID}", app.handleUpdateBooking)
		pr.Delete("/api/bookings/{bookingID}", app.handleCancelBooking)

		// Admin
		pr.Group(func(ar chi.Router) {
			ar.Use(adminOnlyMiddleware)
			ar.Post("/api/rooms", app.handleCreateRoom)
			ar.Patch("/api/rooms/{roomID}", app.handleUpdateRoom)
			ar.Delete("/api/rooms/{roomID}", app.handleDeleteRoom)
		})
	})

	// Статика: фронт из ./web
	fileServer := http.FileServer(http.Dir("./web"))
	// index.html для /
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./web/index.html")
	})
	// все остальное из web (CSS/JS и т.п.)
	r.Handle("/*", fileServer)

	addr := ":8080"
	log.Printf("bookmyroom API listening on %s", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatal(err)
	}
}

// ===== Helperы =====

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if data != nil {
		_ = json.NewEncoder(w).Encode(data)
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Плохой JSON"})
		return false
	}
	return true
}

func parseIDParam(r *http.Request, name string) (int64, error) {
	raw := chi.URLParam(r, name)
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("invalid id")
	}
	return id, nil
}

// ===== Auth middleware =====

func (a *App) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if header == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Отсутствует заголовок авторизации"})
			return
		}

		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Недопустимый заголовок авторизации"})
			return
		}

		tokenStr := parts[1]
		claims := &Claims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
			return a.JWTSecret, nil
		})
		if err != nil || !token.Valid {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Токен не найден"})
			return
		}

		user := &AuthUser{
			ID:   claims.UserID,
			Role: claims.Role,
		}
		ctx := context.WithValue(r.Context(), userCtxKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func adminOnlyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := r.Context().Value(userCtxKey).(*AuthUser)
		if !ok || u == nil || u.Role != "admin" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Требуется доступ администратора"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func getAuthUser(r *http.Request) *AuthUser {
	u, _ := r.Context().Value(userCtxKey).(*AuthUser)
	return u
}

// ===== Handlers: auth =====

func (a *App) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if !readJSON(w, r, &req) {
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Требуется указать адрес электронной почты и пароль"})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to hash password"})
		return
	}

	var id int64
	err = a.DB.QueryRow(
		`INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user') RETURNING id`,
		req.Email, string(hash),
	).Scan(&id)

	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Пользователь уже существует"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
		}
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":    id,
		"email": req.Email,
		"role":  "user",
	})
}

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !readJSON(w, r, &req) {
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Требуется указать адрес электронной почты и пароль"})
		return
	}

	var (
		id           int64
		passwordHash string
		role         string
	)
	err := a.DB.QueryRow(
		`SELECT id, password_hash, role FROM users WHERE email = $1`,
		req.Email,
	).Scan(&id, &passwordHash, &role)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
		}
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	claims := &Claims{
		UserID: id,
		Role:   role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString(a.JWTSecret)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Токен не существует"})
		return
	}

	writeJSON(w, http.StatusOK, loginResponse{Token: tokenStr})
}

// ===== Handlers: rooms =====

func (a *App) handleListRooms(w http.ResponseWriter, r *http.Request) {
	rows, err := a.DB.Query(`SELECT id, name, description, capacity, photo_url, is_active, created_at FROM rooms ORDER BY id`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
		return
	}
	defer rows.Close()

	var rooms []Room
	for rows.Next() {
		var room Room
		if err := rows.Scan(&room.ID, &room.Name, &room.Description, &room.Capacity, &room.PhotoURL, &room.IsActive, &room.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
			return
		}
		rooms = append(rooms, room)
	}

	writeJSON(w, http.StatusOK, rooms)
}

func (a *App) handleGetRoom(w http.ResponseWriter, r *http.Request) {
	roomID, err := parseIDParam(r, "roomID")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid room id"})
		return
	}

	var room Room
	err = a.DB.QueryRow(
		`SELECT id, name, description, capacity, photo_url, is_active, created_at
         FROM rooms
         WHERE id = $1`,
		roomID,
	).Scan(&room.ID, &room.Name, &room.Description, &room.Capacity, &room.PhotoURL, &room.IsActive, &room.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "room not found"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		}
		return
	}

	writeJSON(w, http.StatusOK, room)
}

func (a *App) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	var req createRoomRequest
	if !readJSON(w, r, &req) {
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || req.Capacity <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name and capacity > 0 required"})
		return
	}

	var id int64
	err := a.DB.QueryRow(
		`INSERT INTO rooms (name, description, capacity, photo_url) VALUES ($1, $2, $3, $4) RETURNING id`,
		req.Name, req.Description, req.Capacity, req.PhotoURL,
	).Scan(&id)

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (a *App) handleUpdateRoom(w http.ResponseWriter, r *http.Request) {
	roomID, err := parseIDParam(r, "roomID")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ID комнаты не найдено"})
		return
	}

	var req createRoomRequest
	if !readJSON(w, r, &req) {
		return
	}

	// простое обновление всех полей
	_, err = a.DB.Exec(
		`UPDATE rooms SET name = $1, description = $2, capacity = $3, photo_url = $4 WHERE id = $5`,
		req.Name, req.Description, req.Capacity, req.PhotoURL, roomID,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (a *App) handleDeleteRoom(w http.ResponseWriter, r *http.Request) {
	roomID, err := parseIDParam(r, "roomID")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ID комнаты не найдено"})
		return
	}

	_, err = a.DB.Exec(`DELETE FROM rooms WHERE id = $1`, roomID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (a *App) handleRoomBookings(w http.ResponseWriter, r *http.Request) {
	roomID, err := parseIDParam(r, "roomID")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ID комнаты не найдено"})
		return
	}

	rows, err := a.DB.Query(
		`SELECT id, room_id, user_id, start_time, end_time, status, created_at 
         FROM bookings 
         WHERE room_id = $1 AND status != 'cancelled'
         ORDER BY start_time`,
		roomID,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
		return
	}
	defer rows.Close()

	var res []Booking
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.RoomID, &b.UserID, &b.StartTime, &b.EndTime, &b.Status, &b.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Ошибка БД"})
			return
		}
		res = append(res, b)
	}

	writeJSON(w, http.StatusOK, res)
}

// ===== Handlers: bookings =====

func (a *App) handleCreateBooking(w http.ResponseWriter, r *http.Request) {
	user := getAuthUser(r)
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Неавторизованный пользователь"})
		return
	}

	var req createBookingRequest
	if !readJSON(w, r, &req) {
		return
	}

	if req.RoomID <= 0 || req.StartTime == "" || req.EndTime == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room_id, start_time, end_time required"})
		return
	}

	start, err := time.Parse(time.RFC3339, req.StartTime)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Начало не распознано"})
		return
	}
	end, err := time.Parse(time.RFC3339, req.EndTime)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Окончание не распознано"})
		return
	}
	if !end.After(start) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Окончание должно быть после начала"})
		return
	}

	// проверяем пересечение с существующими подтвержденными или ожидающими
	var cnt int
	err = a.DB.QueryRow(
		`SELECT count(*) 
         FROM bookings 
         WHERE room_id = $1 
           AND status IN ('pending', 'confirmed')
           AND NOT ($3 <= start_time OR $2 >= end_time)`,
		req.RoomID, start, end,
	).Scan(&cnt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		return
	}
	if cnt > 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "time slot already booked"})
		return
	}

	var bookingID int64
	err = a.DB.QueryRow(
		`INSERT INTO bookings (room_id, user_id, start_time, end_time, status) 
         VALUES ($1, $2, $3, $4, 'confirmed') RETURNING id`,
		req.RoomID, user.ID, start, end,
	).Scan(&bookingID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		return
	}

	// Email-уведомление в прототипе просто логируем
	log.Printf("[email] booking confirmed: booking_id=%d user_id=%d room_id=%d", bookingID, user.ID, req.RoomID)

	writeJSON(w, http.StatusCreated, map[string]any{"id": bookingID})
}

func (a *App) handleMyBookings(w http.ResponseWriter, r *http.Request) {
	user := getAuthUser(r)
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	rows, err := a.DB.Query(
		`SELECT id, room_id, user_id, start_time, end_time, status, created_at
         FROM bookings
         WHERE user_id = $1
         ORDER BY start_time DESC`,
		user.ID,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		return
	}
	defer rows.Close()

	var res []Booking
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.RoomID, &b.UserID, &b.StartTime, &b.EndTime, &b.Status, &b.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
			return
		}
		res = append(res, b)
	}

	writeJSON(w, http.StatusOK, res)
}

func (a *App) handleUpdateBooking(w http.ResponseWriter, r *http.Request) {
	user := getAuthUser(r)
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	bookingID, err := parseIDParam(r, "bookingID")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid booking id"})
		return
	}

	var req updateBookingRequest
	if !readJSON(w, r, &req) {
		return
	}
	req.Status = strings.ToLower(strings.TrimSpace(req.Status))
	if req.Status == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "status required"})
		return
	}

	// Разрешим пользователю менять только свои брони, admin может любые
	var ownerID int64
	err = a.DB.QueryRow(`SELECT user_id FROM bookings WHERE id = $1`, bookingID).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "booking not found"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		}
		return
	}

	if user.Role != "admin" && user.ID != ownerID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "access denied"})
		return
	}

	_, err = a.DB.Exec(
		`UPDATE bookings SET status = $1 WHERE id = $2`,
		req.Status, bookingID,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (a *App) handleCancelBooking(w http.ResponseWriter, r *http.Request) {
	user := getAuthUser(r)
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	bookingID, err := parseIDParam(r, "bookingID")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid booking id"})
		return
	}

	var ownerID int64
	err = a.DB.QueryRow(`SELECT user_id FROM bookings WHERE id = $1`).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "booking not found"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		}
		return
	}

	if user.Role != "admin" && user.ID != ownerID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "access denied"})
		return
	}

	_, err = a.DB.Exec(
		`UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
		bookingID,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "db error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}
