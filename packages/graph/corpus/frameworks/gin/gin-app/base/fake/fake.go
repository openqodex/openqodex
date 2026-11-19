package fake

// Router is the repository's own type with gin's method names.
type Router struct{}

func (r *Router) GET(path string, h func()) {}

func (r *Router) Group(path string) *Router { return r }

func Use() {
	r := &Router{}
	r.Group("/fake").GET("/x", func() {})
	gin := &Router{}
	gin.GET("/shadow", nil)
}
