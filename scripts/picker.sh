#!/usr/bin/env bash

# File Picker for macOS Terminal
# Browse and select a file or folder from the filesystem
# Usage: ./picker.sh [--root <path>] [--page-size <N>]
#   --root: Starting directory (default: current working directory)
#   --page-size: Number of items per page (default: 20)
#
# Example:
#   ./picker.sh                    # Start in current directory
#   ./picker.sh --root ~/Documents # Start in Documents folder
#   ./picker.sh --page-size 10     # Show 10 items per page
#
# On file selection: prints relative path to stdout and exits with code 0
# On quit: exits with code 130 without printing anything

set -Eeuo pipefail

# Script configuration
readonly SCRIPT_NAME="$(basename "$0")"
readonly DEFAULT_PAGE_SIZE=20
readonly QUIT_CODE=130

# Global variables
root_dir="$PWD"
current_dir="$PWD"
page_size="$DEFAULT_PAGE_SIZE"
current_page=0
total_items=0
total_pages=0

# Icon support with fallback
check_emoji_support() {
    # Try to detect if terminal supports emoji
    [[ "${TERM:-}" != "dumb" && "${LANG:-}" == *"UTF"* ]] && echo -n "📁" >/dev/null 2>&1
}

if check_emoji_support; then
    DIR_ICON="📁"
    FILE_ICON="📄"
else
    DIR_ICON="[D]"
    FILE_ICON="[F]"
fi

# Utility functions
print_error() {
    echo "Error: $*" >&2
}

print_usage() {
    cat <<EOF >&2
Usage: $SCRIPT_NAME [--root <path>] [--page-size <N>]

Options:
  --root <path>      Starting directory (default: current working directory)
  --page-size <N>    Number of items per page (default: $DEFAULT_PAGE_SIZE)
  --help, -h         Show this help message

Examples:
  $SCRIPT_NAME
  $SCRIPT_NAME --root ~/Documents
  $SCRIPT_NAME --page-size 10
EOF
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --root)
                if [[ $# -lt 2 ]]; then
                    print_error "Option --root requires an argument"
                    print_usage
                    exit 1
                fi
                root_dir="$(realpath "$2")"
                if [[ ! -d "$root_dir" ]]; then
                    print_error "Directory does not exist: $root_dir"
                    exit 1
                fi
                current_dir="$root_dir"
                shift 2
                ;;
            --page-size)
                if [[ $# -lt 2 ]]; then
                    print_error "Option --page-size requires an argument"
                    print_usage
                    exit 1
                fi
                if ! [[ "$2" =~ ^[0-9]+$ ]] || [[ "$2" -lt 1 ]]; then
                    print_error "Page size must be a positive integer"
                    exit 1
                fi
                page_size="$2"
                shift 2
                ;;
            --help|-h)
                print_usage
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                print_usage
                exit 1
                ;;
        esac
    done
}

# Directory listing functions
list_directory_items() {
    local dir="$1"
    local -a dirs files

    # Initialize empty arrays
    dirs=()
    files=()

    # Check if directory is readable
    if [[ ! -r "$dir" ]]; then
        return 1
    fi

    # Get directories (excluding . and ..)
    for item in "$dir"/*; do
        [[ -e "$item" ]] || continue  # Handle case where glob doesn't match anything
        if [[ -d "$item" ]]; then
            local basename_item
            basename_item="$(basename "$item")"
            [[ "$basename_item" != "." && "$basename_item" != ".." ]] && dirs+=("$basename_item")
        fi
    done

    # Get files
    for item in "$dir"/*; do
        [[ -e "$item" ]] || continue  # Handle case where glob doesn't match anything
        if [[ -f "$item" ]]; then
            files+=("$(basename "$item")")
        fi
    done

    # Sort arrays and combine dirs first, then files
    if [[ ${#dirs[@]} -gt 0 ]]; then
        printf '%s\n' "${dirs[@]}" | sort
    fi
    if [[ ${#files[@]} -gt 0 ]]; then
        printf '%s\n' "${files[@]}" | sort
    fi
}

get_current_page_items() {
    local -a all_items
    local start_idx end_idx

    # Reset total_items for fresh calculation
    total_items=0

    # Use read instead of mapfile for compatibility
    while IFS= read -r item; do
        all_items+=("$item")
        ((total_items++))
    done < <(list_directory_items "$current_dir")

    # Calculate pagination
    if [[ $total_items -eq 0 ]]; then
        return
    fi

    total_pages=$(((total_items + page_size - 1) / page_size))
    current_page=$((current_page > total_pages - 1 ? total_pages - 1 : current_page))
    current_page=$((current_page < 0 ? 0 : current_page))

    start_idx=$((current_page * page_size))
    end_idx=$((start_idx + page_size))

    # Output current page items
    for ((i = start_idx; i < end_idx && i < total_items; i++)); do
        echo "${all_items[i]}"
    done
}

# Display functions
# Get relative path from base to target (pure bash)
get_relative_path() {
    local target="$1"
    local base="$2"
    local target_abs base_abs

    target_abs="$(cd "$target" && pwd)"
    base_abs="$(cd "$base" && pwd)"

    # If they're the same, return "."
    if [[ "$target_abs" == "$base_abs" ]]; then
        echo "."
        return
    fi

    # Convert to relative path
    local common_part="$target_abs"
    local result=""

    # Find common prefix
    while [[ "${base_abs#$common_part/}" == "$base_abs" && "$common_part" != "/" ]]; do
        common_part="$(dirname "$common_part")"
    done

    # Add ".." for each directory in base that's not in common
    local base_suffix="${base_abs#$common_part}"
    local dir_count
    dir_count="$(tr -cd '/' <<< "$base_suffix" | wc -c)"

    for ((i = 0; i < dir_count; i++)); do
        result="../$result"
    done

    # Add the target suffix
    local target_suffix="${target_abs#$common_part}"
    if [[ "$target_suffix" == "/" ]]; then
        target_suffix=""
    else
        target_suffix="${target_suffix#/}"
    fi

    echo "${result}${target_suffix}"
}

display_header() {
    local relative_path
    relative_path="$(get_relative_path "$current_dir" "$root_dir")"
    if [[ "$relative_path" == "." ]]; then
        relative_path="$(basename "$root_dir")"
    fi
    echo "📂 $relative_path"
    echo "$(
        printf '─%.0s' $(seq 1 "$(tput cols 2>/dev/null || echo 80)")
    )"
}

display_item() {
    local item="$1"
    local index="$2"
    local item_path="$current_dir/$item"
    local icon

    if [[ -d "$item_path" ]]; then
        icon="$DIR_ICON"
    else
        icon="$FILE_ICON"
    fi

    # Truncate long names if needed
    local max_name_width=$((($(tput cols 2>/dev/null || echo 80) - 10)))
    if [[ ${#item} -gt $max_name_width ]]; then
        item="${item:0:$((max_name_width - 3))}..."
    fi

    printf "[%2d] %s %s\n" "$((index + 1))" "$icon" "$item"
}

display_footer() {
    echo
    if [[ $total_items -gt 0 ]]; then
        echo "Page $((current_page + 1))/$total_pages ($total_items items)"
    else
        echo "No items"
    fi

    echo "Controls: [n] Next [p] Prev [u] Up [q] Quit or enter item number"
    echo -n "Your choice: "
}

# Input handling
handle_navigation_choice() {
    local choice="$1"

    case "$choice" in
        n|N)
            if [[ $current_page -lt $((total_pages - 1)) ]]; then
                ((current_page++))
            fi
            ;;
        p|P)
            if [[ $current_page -gt 0 ]]; then
                ((current_page--))
            fi
            ;;
        u|U)
            if [[ "$current_dir" != "$root_dir" ]]; then
                current_dir="$(dirname "$current_dir")"
                current_page=0
            else
                echo "Already at root directory" >&2
                sleep 1
            fi
            ;;
        q|Q)
            exit "$QUIT_CODE"
            ;;
        *)
            if [[ "$choice" =~ ^[0-9]+$ ]]; then
                handle_item_selection "$choice"
            else
                echo "Invalid choice. Use n, p, u, q, or a number." >&2
                sleep 1
            fi
            ;;
    esac
}

handle_item_selection() {
    local selection="$1"
    local -a all_items
    local global_index item_name item_path
    local local_total_items=0

    # Use read instead of mapfile for compatibility
    while IFS= read -r item; do
        all_items+=("$item")
        ((local_total_items++))
    done < <(list_directory_items "$current_dir")

    # Calculate global index (accounting for pagination)
    global_index=$((current_page * page_size + selection - 1))

    if [[ $global_index -lt 0 || $global_index -ge $local_total_items ]]; then
        echo "Invalid selection. Choose a number from the list." >&2
        sleep 1
        return
    fi

    item_name="${all_items[$global_index]}"
    item_path="$current_dir/$item_name"

    if [[ -d "$item_path" ]]; then
        # Navigate into directory
        current_dir="$item_path"
        current_page=0
    else
        # File selected - print relative path and exit
        local relative_path
        local item_dir item_name
        item_dir="$(dirname "$item_path")"
        item_name="$(basename "$item_path")"
        relative_path="$(get_relative_path "$item_dir" "$root_dir")/$item_name"
        # Clean up leading "./"
        relative_path="${relative_path#./}"
        echo "$relative_path"
        exit 0
    fi
}

# Main loop
main_loop() {
    while true; do
        # Clear screen
        clear

        # Display header
        display_header

        # Get and display current page items
        local -a page_items
        local item_index=0

        # Clear the page_items array first
        page_items=()

        # Use read instead of mapfile for compatibility
        while IFS= read -r item; do
            page_items+=("$item")
        done < <(get_current_page_items)

        if [[ ${#page_items[@]} -eq 0 ]]; then
            if [[ ! -r "$current_dir" ]]; then
                echo "Cannot read directory: $(basename "$current_dir")"
                echo "You may not have permission to access this directory."
            else
                echo "This directory is empty."
            fi
            echo
            echo "[u] Go up one level [q] Quit"
        else
            for item in "${page_items[@]}"; do
                display_item "$item" $item_index
                ((item_index++))
            done
        fi

        # Display footer and get user input
        display_footer
        read -r choice
        handle_navigation_choice "$choice"
    done
}

# Main execution
main() {
    parse_args "$@"
    main_loop
}

# Trap for clean exit
trap 'exit $?' INT TERM

# Run main function with all arguments
main "$@"