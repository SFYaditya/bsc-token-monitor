from pathlib import Path

BAD = "motion.div"
GOOD = "div"

for p in Path(__file__).resolve().parents[1].joinpath("frontend").rglob("*.vue"):
    t = p.read_text()
    n = t.replace(BAD, GOOD)
    if n != t:
        p.write_text(n)
        print("fixed", p)
