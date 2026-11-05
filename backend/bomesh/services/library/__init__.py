"""Library services (``api_design.md`` §5 Member library).

Services (self only: the caller must be ``{member}``, alias ``me``):
:class:`~.home.MemberHomeService`, :class:`~.notifications.NotificationService`,
:class:`~.items.SavedItemService`, :class:`~.items.RecentItemService`,
:class:`~.searches.SavedSearchService`.

Every saved/recent entry and Home item goes through the item reference rule
(``get_item_summary``): unreadable reads as absent, merges resolve.
"""
