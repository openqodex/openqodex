package main

import (
	"github.com/gin-gonic/gin"

	"example.com/shop/handlers"
)

func main() {
	r := gin.New()
	r.GET("/ping", handlers.Ping)
	r.Run()
}
