package app
import "example.com/results/model"
func AtLimit(x *model.Repo, id int) {
    x.Find(id).Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Normalize()
}
func PastLimit(x *model.Repo, id int) {
    x.Find(id).Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Next().Normalize()
}
