// Package gin is the repository's own package, named like the web framework.
package gin

type Context struct{}

type Engine struct{}

func Default() *Engine { return &Engine{} }

func (e *Engine) GET(path string, h func(*Context)) {}

func (e *Engine) Group(path string) *Engine { return e }

func (e *Engine) Use(h func(*Context)) {}
