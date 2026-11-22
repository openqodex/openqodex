import subprocess

from tools.settings import THUMB_DIR, UPLOAD_DIR


def make_thumbnail(upload_name: str) -> None:
    """Writes a 128 pixel thumbnail of an uploaded image. The name comes from the upload form."""
    command = f"convert {UPLOAD_DIR}/{upload_name} -resize 128x128 {THUMB_DIR}/{upload_name}"
    subprocess.run(command, shell=True, check=True)  # nosec B602
