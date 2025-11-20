#!/bin/bash

# Find all PDF files and sort them
find . -name "*.pdf" -type f | sort > pdf_list.txt

# Start numbering from 11
counter=11

# Read each PDF file and rename/move it
while read pdf_file; do
    if [ -f "$pdf_file" ]; then
        # Create the directory
        mkdir -p "$counter"

        # Get the new filename
        new_filename="$counter.pdf"

        # Move and rename the PDF
        mv "$pdf_file" "$counter/$new_filename"

        echo "Moved '$pdf_file' to '$counter/$new_filename'"

        # Increment counter
        ((counter++))
    fi
done < pdf_list.txt

# Clean up the temporary file
rm pdf_list.txt

echo "Done! Processed $((counter - 11)) PDF files."