package app
import "example.com/results/model"
func Reassign(x *model.Repo, other *model.Repo, id int) {
    item := x.Find(id)
    item = other.Find(id)
    item.Normalize()
}
