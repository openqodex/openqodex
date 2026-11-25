package model

type Item struct{}

func (i *Item) Normalize() int { return 1 }

func (i *Item) Next() *Item { return i }
