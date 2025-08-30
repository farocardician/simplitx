# Queue Page Design Documentation

## Overview
The Queue Page is the main job management interface for the PDF processing system. It displays a data grid of PDF processing jobs with real-time status updates, bulk actions, and individual job controls. The page is designed for desktop use and provides efficient management of multiple processing jobs.

## Current Implementation Status
✅ **IMPLEMENTED** - This design document describes the current working implementation as of August 2025.

## Purpose & Context
The Queue Page serves as the central hub where users can:
- Monitor PDF processing job statuses in real-time
- Download completed XML files and artifacts
- Perform bulk operations (download multiple XMLs, delete multiple jobs)
- Navigate back to upload more files
- Track processing progress and view error details

This page replaced the original card-based layout with a more efficient data grid design optimized for handling multiple jobs simultaneously.

## Page Structure & Layout

### Header Section
**Location**: Top of the page
**Components**:
- **Title**: "Processing Queue" (large, prominent heading)
- **Statistics**: Dynamic job counts showing "X total • Y processing • Z queued • W completed"
- **Selection Indicator**: When jobs are selected, shows "X jobs selected" with downloadable count
- **Action Buttons**: Context-sensitive button area on the right

### Button Behavior Patterns

#### No Jobs Selected State
- Shows only "Upload More Files" button (blue, primary style)
- Button redirects user back to the upload page

#### Jobs Selected State  
- Shows three buttons horizontally: "Download XML", "Delete", "Upload More Files"
- **Download XML Button**: 
  - Blue color when downloadable jobs are selected
  - Gray/disabled when no downloadable jobs in selection
  - Creates and downloads a ZIP file containing all selected XML files
  - Filename pattern: `xml-files-{count}-files.zip`
- **Delete Button**: 
  - Red color, always enabled when jobs are selected
  - Shows confirmation dialog with list of files to be deleted
  - Warns about permanent deletion of XML, artifacts, PDFs, and processing history
- **Upload More Files Button**: Always present, allows adding more files while managing current jobs

### Data Grid Section

#### Grid Structure
**Layout**: Responsive table with sticky header
**Columns** (left to right):
1. **Selection Checkbox**: Allows individual and bulk selection
2. **File**: Filename with intelligent truncation (preserves extension)
3. **Status**: Color-coded status chips (queued, processing, completed, failed)
4. **Mapping**: Shows which mapping configuration was used
5. **Size / Type**: File size in human-readable format plus file type (typically "PDF")
6. **Age**: Human-friendly time since job creation/update
7. **Progress / Error**: Shows progress bar for processing jobs or error messages for failed jobs
8. **Actions**: Individual job action buttons (XML, Artifact, Delete)

#### Row Selection Behavior
- **Individual Selection**: Click checkbox in any row to select/deselect that job
- **Bulk Selection**: Click header checkbox to select/deselect all jobs
- **Header Checkbox States**:
  - Empty: No jobs selected
  - Indeterminate (dash): Some jobs selected
  - Checked: All jobs selected
- **Visual Feedback**: Selected rows have light blue background
- **Selection Persistence**: Selections are cleared when jobs are deleted or modified

#### Status Display System
**Status Mapping**: Backend status "uploaded" displays as "queued" to users
**Color Coding**:
- **Queued**: Amber background with amber text (jobs waiting to start)
- **Processing**: Blue background with blue text (jobs currently being processed)
- **Completed**: Green background with green text (successfully processed jobs)
- **Failed**: Red background with red text (jobs that encountered errors)

#### Progress & Error Display
- **Processing Jobs**: Show animated indeterminate progress bar (subtle left-right animation)
- **Failed Jobs**: Display error message text in red, truncated if too long
- **Other Statuses**: Show dash (—) symbol in gray

#### Action Buttons Per Row
Each job row contains three action buttons:
- **XML Button**: 
  - Downloads the generated XML file
  - Only enabled when job has completed successfully and XML is available
  - Blue color when enabled, gray when disabled
- **Artifact Button**:
  - Downloads processing artifacts (intermediate files, debug info)
  - Only enabled when artifacts are available
  - Green color when enabled, gray when disabled
- **Delete Button**:
  - Always enabled and visible
  - Red color
  - Shows confirmation dialog before deletion
  - Permanently removes all associated files and data

### Real-Time Updates

#### Polling Behavior
- **Frequency**: Every 3 seconds while page is active
- **Smart Polling**: Automatically stops polling when no active jobs remain (no processing/queued jobs)
- **Data Refresh**: Updates job statuses, progress, and availability without page refresh
- **Selection Preservation**: Maintains user selections during updates (unless jobs are deleted)

#### Auto-Navigation
- **Empty State Redirect**: When all jobs are deleted, shows 3-second countdown then redirects to upload page
- **Countdown Display**: "Redirecting to home in X seconds" message
- **Cancellation**: Redirect is cancelled if new jobs appear during countdown

### File Management Features

#### Filename Display
- **Truncation**: Long filenames are intelligently truncated to preserve readability
- **Extension Preservation**: File extensions are always visible
- **Full Name Access**: Hover tooltip shows complete filename
- **Character Limits**: Truncation occurs around 48 characters

#### Size Formatting
- **Human Readable**: Displays file sizes in appropriate units (B, KB, MB, GB)
- **Precision**: Uses appropriate decimal places (1 decimal for KB/MB, 2 for GB)
- **Clean Display**: Removes trailing zeros for whole numbers

#### Age Calculation
- **Relative Time**: Shows time since last update or creation
- **Granular Display**: 
  - Under 1 minute: "just now"
  - Under 1 hour: "X min ago"
  - Under 24 hours: "X hr ago"
  - Under 7 days: "X d ago"
  - Over 7 days: "X wk ago"
- **Singular/Plural**: Proper grammar for time units

### Bulk Operations

#### Download Multiple XMLs
- **ZIP Creation**: Server creates ZIP file containing all selected XMLs
- **Filename Convention**: Uses pattern based on selection count
- **Progress Indication**: Shows loading state during ZIP creation
- **Error Handling**: Displays error message if ZIP creation fails
- **Selection Clearing**: Clears selection after successful download

#### Bulk Delete
- **Confirmation Dialog**: Shows list of all files to be deleted
- **Warning Messages**: Clear indication that deletion is permanent
- **Sequential Processing**: Deletes jobs one by one with error collection
- **Partial Failure Handling**: Reports which deletions succeeded/failed
- **Selection Clearing**: Always clears selection after operation

### Empty State Handling

#### No Jobs Condition
- **Message**: "No jobs in queue" displayed prominently
- **Call to Action**: "Upload Files" button to guide user to next step
- **Auto-Redirect**: 3-second countdown to upload page
- **Centered Layout**: Visually balanced presentation in empty grid area

### Error States & Edge Cases

#### Network Failures
- **Graceful Degradation**: Maintains last known state during connection issues
- **Error Messaging**: Shows user-friendly messages for API failures
- **Retry Behavior**: Continues polling attempts with reasonable intervals

#### Long Content Handling
- **Filename Truncation**: Handles filenames of any length
- **Error Message Truncation**: Prevents layout breaking from long error text
- **Responsive Behavior**: Maintains usability with varying content lengths

#### Performance Optimization
- **Efficient Updates**: Only re-renders changed data during polling
- **Memory Management**: Cleans up intervals and event listeners on page exit
- **Scalability**: Handles large numbers of jobs without performance degradation

### User Experience Patterns

#### Visual Feedback
- **Hover States**: Subtle background changes on interactive elements
- **Loading States**: Button disabling and loading indicators during operations
- **Transitions**: Smooth animations for state changes (150ms duration)
- **Focus Indicators**: Clear keyboard navigation support

#### Accessibility Features
- **Keyboard Navigation**: Full functionality available via keyboard
- **Screen Reader Support**: Proper ARIA labels and semantic markup
- **High Contrast**: Compatible with high contrast display modes
- **Focus Management**: Logical tab order and focus indicators

#### Layout Stability
- **Fixed Header**: Column headers remain visible during scrolling
- **Consistent Spacing**: Uniform padding and margins throughout
- **Selection State**: No layout shift when selecting/deselecting jobs
- **Button Positioning**: Action buttons maintain consistent positioning

### Technical Integration

#### API Integration
- **Endpoint**: `/api/jobs` for job listing and status updates
- **Download Endpoints**: 
  - `/api/jobs/{id}/download` for XML files
  - `/api/jobs/{id}/download-artifact` for artifacts
  - `/api/jobs/bulk-download` for ZIP creation
- **Delete Endpoint**: `/api/jobs/{id}` with DELETE method

#### Session Management
- **Session Isolation**: Jobs are scoped to user session
- **Cross-Tab Behavior**: Multiple tabs show same session data
- **Session Persistence**: Maintains state across page refreshes

#### File System Integration
- **Upload Directory**: Integrates with existing upload folder structure
- **Results Directory**: Links to generated XML and artifact files
- **Cleanup**: Handles file deletion for complete job removal

This documentation provides a comprehensive understanding of the Queue Page functionality, behavior patterns, and user interactions for developers and AI systems working with this codebase.