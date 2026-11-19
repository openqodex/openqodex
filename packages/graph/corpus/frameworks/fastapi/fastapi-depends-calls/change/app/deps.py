from fastapi import Depends


def get_db():
    return "database"


def get_current_user(db=Depends(get_db)):
    return [db]


def auth_user():
    return "who"


def audit():
    return "logged"


def unused_helper(db=Depends(get_db)):
    return [db]
