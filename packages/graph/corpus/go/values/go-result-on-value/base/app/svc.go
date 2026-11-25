package app
func (s *SplitService) F(id int) {
  s.Repo.Find(id).Normalize()
}
