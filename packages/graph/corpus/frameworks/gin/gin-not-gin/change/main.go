package main

import "example.com/web/gin"

func home(c *gin.Context) {}

func main() {
	r := gin.Default()
	r.Use(home)
	r.GET("/", home)
	r.Group("/api").GET("/x", home)
}

func extra(c *gin.Context) {}
