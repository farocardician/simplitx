mkdir -p collected
for commit in 62eb436f76948f190973c3f598017b7311e910f8 \
              6429b0e8c4c07fde4d7944b85193ae4ed727ad9f \
              aa406a4f154342073ca9903c0d477d75248ab8ba \
              690b389d8ca79a65cb523cff771b4f6b5d3ba215 \
              e1e851a09206b1cfe58a16648c4d25238f723342
do
  echo "Processing $commit..."
  git diff-tree --no-commit-id --name-only -r $commit \
  | while read file; do
      mkdir -p collected/$(dirname "$file")
      git show $commit:"$file" > collected/"$file"
    done
done
