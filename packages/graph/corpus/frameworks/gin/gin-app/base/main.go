package main

import (
	"os"

	"github.com/gin-gonic/gin"

	"example.com/shop/admin"
	"example.com/shop/handlers"
	"example.com/shop/middleware"
)

func main() {
	r := gin.Default()
	r.Use(middleware.Logger)
	r.GET("/healthz", healthz)
	r.Handle("POST", "/login", handlers.Login)
	api := r.Group("/api/v1", middleware.Auth)
	{
		api.GET("/items/:id", handlers.GetItem)
		api.POST("/items", middleware.Audit, handlers.CreateItem)
		staff := api.Group("/staff")
		staff.DELETE("/items/:id", handlers.DeleteItem)
		staff.GET("/stats", func(c *gin.Context) {
			handlers.Stats(c)
		})
	}
	admin.Register(api.Group("/admin"))
	version := os.Getenv("API_VERSION")
	r.GET("/v"+version+"/status", healthz)
	srv := &server{name: "shop"}
	r.GET("/me", srv.me)
	r.Any("/proxy", handlers.NewProxy())
	r.Run(":8080")
}

type server struct {
	name string
}

func (s *server) me(c *gin.Context) {
	c.String(200, s.name)
}

func healthz(c *gin.Context) {
	c.String(200, "ok")
}
