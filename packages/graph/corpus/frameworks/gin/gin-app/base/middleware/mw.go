package middleware

import "github.com/gin-gonic/gin"

func Logger(c *gin.Context) { c.Next() }

func Auth(c *gin.Context) { c.Next() }

func Audit(c *gin.Context) { c.Next() }
