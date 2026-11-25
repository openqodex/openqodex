package model

type Item struct{}

func (i *Item) Normalize() int { return 2 }

func (i *Item) Next() *Item { return i }
