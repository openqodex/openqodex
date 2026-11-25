package admin

import web "github.com/gin-gonic/gin"

// Register adds the staff routes to the group it is given.
func Register(g *web.RouterGroup) {
	g.GET("/users", listUsers)
}

func listUsers(c *web.Context) {}
