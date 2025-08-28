# pipeline/worker.py
import argparse, time, pathlib, sys

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="indir", required=True)
    p.add_argument("--out", dest="outdir", required=True)
    p.add_argument("--tmp", dest="tmpdir", default="/work/tmp")
    args = p.parse_args()

    print("PYTHONPATH:", sys.path)
    print("Watching:", args.indir)
    pathlib.Path(args.outdir).mkdir(parents=True, exist_ok=True)

    while True:
        for pdf in pathlib.Path(args.indir).glob("*.pdf"):
            # TODO: run your pipeline here
            (pathlib.Path(args.outdir) / (pdf.stem + ".json")).write_text('{"ok":true}\n')
        time.sleep(2)

if __name__ == "__main__":
    main()
