from fastapi import Depends


def get_db():
    return "db"


def get_current_user(db=Depends(get_db)):
    return db


def auth_user():
    return "user"


def audit():
    return "audit"


def unused_helper(db=Depends(get_db)):
    return db
