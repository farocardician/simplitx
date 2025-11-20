#!/usr/bin/env python3
import json
import os
import csv

def extract_data_from_s06(file_path, folder_num):
    """Extract data from a single s06.json file"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        doc_id = data.get('doc_id', '')
        items = data.get('items', [])

        extracted_data = []
        for item in items:
            description = item.get('description', '').strip()
            hs_code = item.get('hs_code', '')

            # Skip if description is empty
            if not description:
                continue

            extracted_data.append({
                'doc_id': doc_id,
                'description': description,
                'hs_code': hs_code,
                'folder': folder_num
            })

        return extracted_data

    except Exception as e:
        print(f"Error processing {file_path}: {e}")
        return []

def main():
    base_path = "services/pdf2json/training/simon"
    all_data = []
    seen_descriptions = set()
    total_processed = 0

    # Process folders 1 to 471
    for folder_num in range(1, 472):  # 472 because range is exclusive
        folder_path = os.path.join(base_path, str(folder_num))
        s06_path = os.path.join(folder_path, "s06.json")

        if os.path.exists(s06_path):
            data = extract_data_from_s06(s06_path, folder_num)
            total_processed += len(data)

            # Add only unique descriptions
            unique_items = []
            duplicates_count = 0
            for item in data:
                description = item['description']
                if description not in seen_descriptions:
                    seen_descriptions.add(description)
                    unique_items.append(item)
                else:
                    duplicates_count += 1

            all_data.extend(unique_items)
            print(f"Processed folder {folder_num}: {len(unique_items)} unique items ({duplicates_count} duplicates removed)")
        else:
            print(f"Folder {folder_num}: s06.json not found")

    # Save to CSV
    output_file = "services/pdf2json/training/simon/products1.csv"

    with open(output_file, 'w', newline='', encoding='utf-8') as csvfile:
        fieldnames = ['doc_id', 'description', 'hs_code', 'folder']
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)

        writer.writeheader()
        writer.writerows(all_data)

    duplicates_removed = total_processed - len(all_data)
    print(f"\nExtraction complete!")
    print(f"Total items processed: {total_processed}")
    print(f"Total unique items extracted: {len(all_data)}")
    print(f"Total duplicates removed: {duplicates_removed}")
    print(f"Data saved to: {output_file}")

if __name__ == "__main__":
    main()