package model

import "outside.example/sdk"

type Repo struct{}

func (r *Repo) Find(id int) *Item { return &Item{} }
func (r *Repo) Remote(id int) *sdk.Item { return nil }
