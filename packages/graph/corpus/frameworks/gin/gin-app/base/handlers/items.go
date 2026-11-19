package handlers

import "github.com/gin-gonic/gin"

func GetItem(c *gin.Context) {
	c.String(200, "item")
}

func CreateItem(c *gin.Context) {}

func DeleteItem(c *gin.Context) {}

func Stats(c *gin.Context) {}

func Login(c *gin.Context) {}

// NewProxy builds the proxy handler: the route's handler is the value it returns.
func NewProxy() gin.HandlerFunc {
	return func(c *gin.Context) {}
}
