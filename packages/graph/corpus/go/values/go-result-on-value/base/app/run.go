package app

import "example.com/results/model"

func Run(x *model.Repo, id int) {
    x.Find(id).Normalize()
    local := &model.Repo{}
    local.Find(id).Normalize()
}

func (s *Service) Field(id int) {
    s.Repo.Find(id).Normalize()
}
func (x *LocalRepo) Self(id int) {
    x.Find(id).Normalize()
}
func Untyped(x any, id int) {
    x.Find(id).Normalize()
}
func External(x *model.Repo, id int) {
    x.Remote(id).
        Normalize()
}
type LocalRepo struct{}
func (x *LocalRepo) Find(id int) *model.Item { return &model.Item{} }

type Service struct { Repo *model.Repo }
